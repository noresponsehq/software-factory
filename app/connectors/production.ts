import { execFile } from "node:child_process";
import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { z } from "zod";
import { type RepoContext, requireEnv } from "../config/index.js";
import { type GitHubHttp, gitData, githubToken } from "../github/index.js";
import { AcceptanceRecipe, proofFailure, proveRelease, recipePath, resolveFixture } from "./acceptance.js";
import { Ledger } from "./ledger.js";
import { type Assertion, type FailureClass, sha256, uploadArtifacts, type VerificationBundle } from "./bundle.js";
import { FactoryFailure } from "./failure.js";
import { productionFailure } from "./production-evidence.js";
import { contains } from "./release.js";

const exec = promisify(execFile);
const SELECTION = "version,search --size 5";
const STAGE_CLASS: Record<string, FailureClass> = {
	prerequisites: "missing_prerequisite",
	version_before: "superseded_release",
	version_after: "superseded_release",
	production_smoke: "product_failure",
	read_summary: "product_failure",
	validate_result: "product_failure",
};
export const productionFailureClass = (stage: string): FailureClass => STAGE_CLASS[stage] ?? "environment_failure";

async function proofFiles(dir: string) {
	const entries = await readdir(dir, { recursive: true, withFileTypes: true }).catch(() => []);
	const files: { name: string; content: Buffer }[] = [];
	for (const entry of entries.filter((e) => e.isFile()).slice(0, 60)) {
		const path = join(entry.parentPath, entry.name);
		files.push({ name: path.slice(dir.length + 1), content: await readFile(path) });
	}
	return files;
}

export async function productionSearch(
	repo: RepoContext,
	merge: string,
	options: { taskSha256: string; store: (payload: Record<string, unknown>) => Promise<string> },
	signal?: AbortSignal,
) {
	if (!/^[a-f0-9]{40}$/.test(merge)) throw new Error("Invalid production revision");
	const trusted = await gitData(repo).getRef(repo.config.baseBranch);
	if (!trusted) throw new Error("Cannot resolve trusted operator source");
	const dir = await mkdtemp(join(tmpdir(), "nr-tmp-production-"));
	let stage = "initialize";
	let smokeExit: number | undefined;
	let recipe = sha256(SELECTION);
	let observed: string | null = null;
	const assertions: Assertion[] = [];
	const bundle = async (outcome: VerificationBundle["outcome"], failure: FailureClass | null): Promise<VerificationBundle> => {
		const uploaded = await uploadArtifacts(await proofFiles(join(dir, "proof")), options.store);
		return {
			version: 1,
			stage: "production",
			outcome,
			failure_class: failure,
			task_sha256: options.taskSha256,
			acceptance_recipe_sha256: recipe,
			candidate_sha: merge,
			trusted_base_sha: trusted,
			observed_release_sha: observed,
			fixtures: [],
			session_generations: [],
			selection: SELECTION,
			reproduction: [
				`git checkout ${trusted} && cd apps/identity && bash deploy/fly/prod-smoke.sh registry.fly.io/nr-ii-prod-api:${merge} <previous> --only version,search`,
			],
			assertions,
			negative_control: null,
			artifacts: uploaded.artifacts,
			harness: null,
			uncovered: ["production smoke has no paired negative control", ...uploaded.uncovered].slice(0, 50),
		};
	};
	try {
		signal?.throwIfAborted();
		stage = "prerequisites";
		const searchKey = requireEnv("NR_PROD_SEARCH_API_KEY");
		stage = "initialize";
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
		observed = /^[a-f0-9]{40}$/.test(before.build_version) ? before.build_version : null;
		if (before.build_version !== merge) throw new Error("Production is not running the merged revision");
		const previousSha = (await gitData(repo).getCommit(merge)).parents[0];
		if (!previousSha) throw new Error("Release has no previous revision");
		const previous = `registry.fly.io/nr-ii-prod-api:${previousSha}`;
		const empty = join(dir, "empty-settings");
		await writeFile(empty, "", { mode: 0o600 });
		const image = `registry.fly.io/nr-ii-prod-api:${merge}`;
		const identity = join(dir, "apps/identity");
		stage = "read_recipe";
		recipe = sha256(JSON.stringify([SELECTION, await readFile(join(identity, "deploy/fly/prod-smoke.sh"), "utf8")]));
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
				NR_PROD_SEARCH_API_KEY: searchKey,
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
		observed = /^[a-f0-9]{40}$/.test(after.build_version) ? after.build_version : null;
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
		const checks = summary.harness.steps.length + summary.providers.search.steps.length;
		assertions.push(
			{ name: "release", expected: merge, observed: merge, passed: true },
			{ name: "smoke checks", expected: "all pass, none skipped", observed: `${checks} pass, ${summary.gaps.length} skipped`, passed: true },
		);
		return {
			sha: merge,
			operator_sha: trusted,
			selection: SELECTION,
			exit_code: 0,
			status: summary.status,
			checks,
			failed: 0,
			skipped: summary.gaps.length,
			bundle: await bundle("verified", null),
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
		const failure = productionFailureClass(stage);
		assertions.push({ name: stage, expected: "pass", observed: "fail", passed: false });
		let failed: VerificationBundle | null = null;
		try {
			failed = await bundle("failed", failure);
		} catch {}
		throw new FactoryFailure("production", failure, {
			...payload,
			failure_class: failure,
			sha: merge,
			operator_sha: trusted,
			selection: SELECTION,
			bundle: failed,
		});
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
}

const api = "https://api.noresponse.org";
const Health = z.object({ ledger: z.object({ rev: z.number().int().nonnegative() }) });

export async function readRecipe(http: GitHubHttp, repo: string, merge: string, connector: string) {
	let raw: unknown;
	try {
		raw = await http.json("GET", `/repos/${repo}/contents/${recipePath(connector)}`, { query: { ref: merge } });
	} catch {
		throw proofFailure("acceptance_recipe_missing", { connector, sha: merge });
	}
	const file = z.object({ content: z.string(), encoding: z.literal("base64") }).safeParse(raw);
	const recipe = file.success ? AcceptanceRecipe.safeParse(JSON.parse(Buffer.from(file.data.content, "base64").toString("utf8"))) : null;
	if (!recipe?.success || recipe.data.connector !== connector) throw proofFailure("acceptance_recipe_missing", { connector, sha: merge });
	return recipe.data;
}

async function publicJson(path: string, init: { method?: string; body?: unknown } = {}) {
	const response = await fetch(`${api}${path}`, {
		method: init.method ?? "GET",
		headers: { authorization: `Bearer ${requireEnv("NR_PROD_SEARCH_API_KEY")}`, "content-type": "application/json" },
		body: init.body === undefined ? undefined : JSON.stringify(init.body),
		signal: AbortSignal.timeout(30000),
	});
	if (!response.ok) throw new Error(`Public API answered ${response.status}`);
	return response.status === 204 ? null : response.json();
}

export async function groupPersonLookup(
	recipe: AcceptanceRecipe,
	sleep: (ms: number) => Promise<void>,
	readControls: (connector: string) => Promise<unknown> = (id) => new Ledger(requireEnv("NR_LEDGER_URL"), requireEnv("NR_FACTORY_OPERATOR_TOKEN")).controls(id),
) {
	const identity = await resolveFixture(recipe, readControls);
	const group = z
		.object({ id: z.string() })
		.parse(await publicJson("/v1/groups", { method: "POST", body: { name: `nr-tmp-proof-${recipe.connector}` } }));
	const added = z
		.object({ items: z.array(z.object({ id: z.string() })).min(1) })
		.parse(await publicJson(`/v1/groups/${group.id}/people`, { method: "POST", body: { people: [identity] } }));
	const person = added.items[0]?.id as string;
	try {
		for (let poll = 0; poll < 60; poll++) {
			const report = z.object({ lookup: z.unknown().optional() }).parse(await publicJson(`/v1/groups/${group.id}/people/${person}`));
			if (report.lookup) return report.lookup;
			await sleep(10000);
		}
		return null;
	} finally {
		await publicJson(`/v1/people/${person}`, { method: "DELETE" }).catch(() => undefined);
	}
}

export async function productionVerify(
	repo: RepoContext,
	http: GitHubHttp,
	merge: string,
	connector: string,
	options: { taskSha256: string; store: (payload: Record<string, unknown>) => Promise<string> },
	signal?: AbortSignal,
) {
	const recipe = await readRecipe(http, repo.fullName, merge, connector);
	const fixture = recipe.fixtures.find((f) => f.ref === recipe.operation.fixture);
	const control = fixture && "control" in fixture ? fixture.control : undefined;
	const requiredRevision = Math.max(recipe.observe.ledger_revision, control?.rev ?? 0);
	const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
	const version = async () =>
		z.object({ build_version: z.string() }).parse(await (await fetch(`${api}/version`, { signal: AbortSignal.timeout(30000) })).json()).build_version;
	const revisions = async () => {
		const apiRev = Health.safeParse(await (await fetch(`${api}/healthz`, { signal: AbortSignal.timeout(30000) })).json().catch(() => null));
		const worker = await exec("fly", ["ssh", "console", "--app", "nr-ii-prod-worker", "--command", "wget -qO- http://127.0.0.1:9091/healthz"], {
			env: { PATH: process.env.PATH, HOME: process.env.HOME, FLY_API_TOKEN: requireEnv("FACTORY_FLY_API_TOKEN") },
			timeout: 60000,
			signal,
		}).then(
			(result) => Health.safeParse(JSON.parse(result.stdout)),
			() => null,
		);
		return { api: apiRev.success ? apiRev.data.ledger.rev : null, worker: worker?.success ? worker.data.ledger.rev : null };
	};
	const proof = await proveRelease(merge, { ...recipe, observe: { ledger_revision: requiredRevision } }, {
		version,
		contains: (older, newer) => contains(http, repo.fullName, older, newer),
		revisions,
		smoke: (build) => productionSearch(repo, build, options, signal),
		lookup: (r) => groupPersonLookup(r, sleep),
		clock: { now: Date.now, sleep, timeoutMs: 300000, intervalMs: 5000 },
	});
	const bundle: VerificationBundle = {
		...proof.bundle,
		fixtures: [...proof.bundle.fixtures, ...(control ? [{ name: `control:${control.connector}:${control.variant}:${control.rev}`, sha256: sha256(JSON.stringify(control)) }] : [])],
		acceptance_recipe_sha256: sha256(JSON.stringify(recipe)),
		candidate_sha: merge,
		observed_release_sha: proof.observed,
		assertions: [
			...proof.bundle.assertions,
			{
				name: `connector ${recipe.connector}`,
				expected: `${recipe.expect.execution} with ${recipe.expect.fields.join(", ") || "no fields"}`,
				observed: `${proof.behaviour.execution}, ${proof.behaviour.records} records`,
				passed: true,
			},
		],
		uncovered: [...proof.bundle.uncovered, ...recipe.uncovered].slice(0, 50),
	};
	return { ...proof, bundle };
}
