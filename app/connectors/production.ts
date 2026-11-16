import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { z } from "zod";
import { type RepoContext, requireEnv } from "../config/index.js";
import { gitData, githubToken } from "../github/index.js";
import { FactoryFailure } from "./failure.js";
import { productionFailure } from "./production-evidence.js";

const exec = promisify(execFile);
export async function productionSearch(repo: RepoContext, merge: string, signal?: AbortSignal) {
	if (!/^[a-f0-9]{40}$/.test(merge)) throw new Error("Invalid production revision");
	const trusted = await gitData(repo).getRef(repo.config.baseBranch);
	if (!trusted) throw new Error("Cannot resolve trusted operator source");
	const dir = await mkdtemp(join(tmpdir(), "nr-tmp-production-"));
	let stage = "initialize";
	let smokeExit: number | undefined;
	try {
		signal?.throwIfAborted();
		const cleanEnv = { PATH: process.env.PATH, HOME: dir, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null" };
		const checkout = async (fullName: string, name: string, sha: string, destination: string) => {
			await exec("git", ["init", destination], { env: cleanEnv, signal });
			await exec("git", ["-C", destination, "remote", "add", "origin", `https://github.com/${fullName}.git`], { env: cleanEnv, signal });
			const readToken = await githubToken({ installationId: repo.installationId, repo: name, permissions: { contents: "read" } });
			await exec("git", ["-C", destination, "fetch", "--depth=1", "origin", sha], {
				env: {
					...cleanEnv,
					GIT_CONFIG_COUNT: "1",
					GIT_CONFIG_KEY_0: "http.extraHeader",
					GIT_CONFIG_VALUE_0: `Authorization: Basic ${Buffer.from(`x-access-token:${readToken}`).toString("base64")}`,
				},
				timeout: 120000,
				signal,
			});
			await exec("git", ["-C", destination, "checkout", "--detach", sha], { env: cleanEnv, signal });
			const actual = await exec("git", ["-C", destination, "rev-parse", "HEAD"], { env: cleanEnv, signal });
			if (actual.stdout.trim() !== sha) throw new Error("Trusted source revision mismatch");
		};
		stage = "fetch_operator";
		await checkout(repo.fullName, repo.name, trusted, dir);
		stage = "version_before";
		const before = z
			.object({ build_version: z.string() })
			.parse(await (await fetch("https://api.noresponse.org/version", { signal: AbortSignal.timeout(30000) })).json());
		if (before.build_version !== merge) throw new Error("Production is not running the merged revision");
		const previousSha = (await gitData(repo).getCommit(merge)).parents[0];
		if (!previousSha) throw new Error("Release has no previous revision");
		const previous = `registry.fly.io/nr-ii-prod-api:${previousSha}`;
		const empty = join(dir, "empty-settings");
		await writeFile(empty, "", { mode: 0o600 });
		const image = `registry.fly.io/nr-ii-prod-api:${merge}`;
		const identity = join(dir, "apps/identity");
		stage = "fetch_sdk_generator";
		const generator = z
			.strictObject({
				repository: z.literal("https://github.com/noresponsehq/noresponse-openapi-generation.git"),
				commit: z.string().regex(/^[a-f0-9]{40}$/),
			})
			.parse(JSON.parse(await readFile(join(identity, "sdks/generator.lock"), "utf8")));
		const generatorSource = join(dir, "trusted-sdk-generator");
		await checkout("noresponsehq/noresponse-openapi-generation", "noresponse-openapi-generation", generator.commit, generatorSource);
		stage = "install_regression";
		await exec("npm", ["ci", "--ignore-scripts"], { cwd: join(identity, "integrations/regression"), env: cleanEnv, timeout: 120000, signal });
		stage = "production_smoke";
		const result = await exec("bash", ["deploy/fly/prod-smoke.sh", image, previous, "--only", "version,search"], {
			cwd: identity,
			env: {
				...cleanEnv,
				NR_FLY_ENV: "prod",
				NR_PROD_SMOKE_ENV_FILES: empty,
				NR_PROD_SMOKE_DIR: join(dir, "proof"),
				NR_PROD_SEARCH_API_KEY: requireEnv("NR_PROD_SEARCH_API_KEY"),
				NR_PROD_WORKER_LOGS_TOKEN: process.env.NR_PROD_WORKER_LOGS_TOKEN ?? "",
				NORESPONSE_SDKGEN_SOURCE: generatorSource,
			},
			timeout: 900000,
			signal,
			maxBuffer: 8 * 1024 * 1024,
		});
		smokeExit = 0;
		stage = "version_after";
		const after = z
			.object({ build_version: z.string() })
			.parse(await (await fetch("https://api.noresponse.org/version", { signal: AbortSignal.timeout(30000) })).json());
		if (after.build_version !== merge) throw new Error("Production changed during verification");
		stage = "read_summary";
		const summary = z
			.object({
				status: z.literal("pass"),
				gaps: z.array(z.unknown()).length(0),
				api_version: z.object({ before: z.object({ build_version: z.literal(merge) }), after: z.object({ build_version: z.literal(merge) }) }),
				harness: z.object({ steps: z.array(z.object({ ok: z.literal(true) })) }),
				providers: z.object({ search: z.object({ steps: z.array(z.object({ ok: z.literal(true) })).min(1) }) }),
			})
			.parse(JSON.parse(await readFile(join(dir, "proof/search-summary.json"), "utf8")));
		stage = "validate_result";
		z.object({ ok: z.literal(true), commit: z.literal(merge) }).parse(JSON.parse(result.stdout));
		return {
			sha: merge,
			operator_sha: trusted,
			selection: "version,search --size 5",
			exit_code: 0,
			status: summary.status,
			checks: summary.harness.steps.length + summary.providers.search.steps.length,
			failed: 0,
			skipped: summary.gaps.length,
		};
	} catch (error) {
		let summary: unknown;
		try {
			summary = JSON.parse(await readFile(join(dir, "proof/search-summary.json"), "utf8"));
		} catch {
			summary = null;
		}
		const payload = productionFailure(stage, error, summary);
		if (smokeExit !== undefined) payload.exit_code = smokeExit;
		throw new FactoryFailure("production", { ...payload, sha: merge, operator_sha: trusted, selection: "version,search --size 5" });
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
}
