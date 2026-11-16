import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { z } from "zod";
import { type RepoContext, requireEnv } from "../config/index.js";
import { gitData, githubToken } from "../github/index.js";

import { FactoryFailure } from "./failure.js";

const exec = promisify(execFile);
export async function productionSearch(repo: RepoContext, merge: string, signal?: AbortSignal) {
	if (!/^[a-f0-9]{40}$/.test(merge)) throw new Error("Invalid production revision");
	const trusted = await gitData(repo).getRef(repo.config.baseBranch);
	if (!trusted) throw new Error("Cannot resolve trusted operator source");
	const dir = await mkdtemp(join(tmpdir(), "nr-tmp-production-"));
	try {
		signal?.throwIfAborted();
		const cleanEnv = { PATH: process.env.PATH, HOME: dir, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null" };
		await exec("git", ["init", dir], { env: cleanEnv, signal });
		await exec("git", ["-C", dir, "remote", "add", "origin", `https://github.com/${repo.fullName}.git`], { env: cleanEnv, signal });
		const readToken = await githubToken({ installationId: repo.installationId, repo: repo.name, permissions: { contents: "read" } });
		await exec("git", ["-C", dir, "fetch", "--depth=1", "origin", trusted], {
			env: {
				...cleanEnv,
				GIT_CONFIG_COUNT: "1",
				GIT_CONFIG_KEY_0: "http.extraHeader",
				GIT_CONFIG_VALUE_0: `Authorization: Basic ${Buffer.from(`x-access-token:${readToken}`).toString("base64")}`,
			},
			timeout: 120000,
			signal,
		});
		await exec("git", ["-C", dir, "checkout", "--detach", trusted], { env: cleanEnv, signal });
		const actual = await exec("git", ["-C", dir, "rev-parse", "HEAD"], { env: cleanEnv, signal });
		if (actual.stdout.trim() !== trusted) throw new Error("Trusted operator revision mismatch");
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
		await exec("npm", ["ci", "--ignore-scripts"], { cwd: join(identity, "integrations/regression"), env: cleanEnv, timeout: 120000, signal });
		const result = await exec("bash", ["deploy/fly/prod-smoke.sh", image, previous, "--only", "version,search"], {
			cwd: identity,
			env: {
				...cleanEnv,
				NR_FLY_ENV: "prod",
				NR_PROD_SMOKE_ENV_FILES: empty,
				NR_PROD_SMOKE_DIR: join(dir, "proof"),
				NR_PROD_SEARCH_API_KEY: requireEnv("NR_PROD_SEARCH_API_KEY"),
				FLY_API_TOKEN: requireEnv("FLY_API_TOKEN"),
			},
			timeout: 900000,
			signal,
			maxBuffer: 8 * 1024 * 1024,
		});
		const after = z
			.object({ build_version: z.string() })
			.parse(await (await fetch("https://api.noresponse.org/version", { signal: AbortSignal.timeout(30000) })).json());
		if (after.build_version !== merge) throw new Error("Production changed during verification");
		const summary = z
			.object({
				status: z.literal("pass"),
				gaps: z.array(z.unknown()).length(0),
				api_version: z.object({ before: z.object({ build_version: z.literal(merge) }), after: z.object({ build_version: z.literal(merge) }) }),
				harness: z.object({ steps: z.array(z.object({ ok: z.literal(true) })) }),
				providers: z.object({ search: z.object({ steps: z.array(z.object({ ok: z.literal(true) })).min(1) }) }),
			})
			.parse(JSON.parse(await readFile(join(dir, "proof/search-summary.json"), "utf8")));
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
	} catch {
		throw new FactoryFailure("production", {
			status: "fail",
			sha: merge,
			operator_sha: trusted,
			selection: "version,search --size 5",
			checks: 0,
			failed: 1,
			skipped: 0,
		});
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
}
