import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";

const fake = vi.hoisted(() => ({
	execute: vi.fn(),
	token: vi.fn(),
	repository: "https://github.com/noresponsehq/noresponse-openapi-generation.git",
}));
vi.mock("node:child_process", () => ({ execFile: Object.assign(vi.fn(), { [Symbol.for("nodejs.util.promisify.custom")]: fake.execute }) }));
vi.mock("../app/github/index.js", () => ({
	gitData: () => ({ getRef: async () => "a".repeat(40), getCommit: async () => ({ parents: ["b".repeat(40)] }) }),
	githubToken: fake.token,
}));
vi.mock("../app/config/index.js", async (original) => ({
	...(await original<typeof import("../app/config/index.js")>()),
	requireEnv: () => "offline-search-key",
}));
import type { RepoContext } from "../app/config/index.js";
import { bundleRefusal } from "../app/connectors/bundle.js";
import { productionSearch } from "../app/connectors/production.js";

const repo: RepoContext = {
	owner: "noresponsehq",
	name: "noresponse",
	fullName: "noresponsehq/noresponse",
	installationId: 1,
	config: { baseBranch: "main", verify: [] },
};
const sha = "c".repeat(40);
function service() {
	fake.repository = "https://github.com/noresponsehq/noresponse-openapi-generation.git";
	fake.token.mockReset().mockImplementation(async ({ repo }) => `offline-${repo}-credential`);
	fake.execute.mockReset().mockImplementation(async (command: string, args: string[], options: { env: Record<string, string>; cwd?: string }) => {
		if (command === "git" && args[0] === "init") await mkdir(args[1] as string, { recursive: true });
		if (command === "git" && args.includes("checkout") && args.at(-1) === "a".repeat(40)) {
			const sdks = join(args[1] as string, "apps/identity/sdks");
			await mkdir(sdks, { recursive: true });
			await writeFile(join(sdks, "generator.lock"), JSON.stringify({ repository: fake.repository, commit: "d".repeat(40) }));
			await mkdir(join(args[1] as string, "apps/identity/deploy/fly"), { recursive: true });
			await writeFile(join(args[1] as string, "apps/identity/deploy/fly/prod-smoke.sh"), "smoke");
		}
		if (command === "git" && args.includes("rev-parse"))
			return { stdout: args[1]?.endsWith("trusted-sdk-generator") ? "d".repeat(40) : "a".repeat(40), stderr: "" };
		if (command === "bash") {
			const proof = options.env.NR_PROD_SMOKE_DIR as string;
			await mkdir(proof, { recursive: true });
			await writeFile(
				join(proof, "search-summary.json"),
				JSON.stringify({
					status: "pass",
					gaps: [],
					api_version: { before: { build_version: sha }, after: { build_version: sha } },
					harness: { steps: [{ ok: true }] },
					providers: { search: { steps: [{ ok: true }] } },
				}),
			);
			return { stdout: JSON.stringify({ ok: true, commit: sha }), stderr: "" };
		}
		return { stdout: "", stderr: "" };
	});
	vi.stubGlobal(
		"fetch",
		vi.fn(async () => Response.json({ build_version: sha })),
	);
}
afterEach(() => vi.unstubAllGlobals());
const stored: Record<string, unknown>[] = [];
const options = () => {
	stored.length = 0;
	return {
		taskSha256: "e".repeat(64),
		store: async (payload: Record<string, unknown>) => {
			stored.push(payload);
			return `ev-${stored.length}`;
		},
	};
};
it("fetches the pinned private generator with a repository-scoped read credential removed before execution", async () => {
	service();
	expect(await productionSearch(repo, sha, options())).toMatchObject({ status: "pass", checks: 2 });
	expect(fake.token.mock.calls.map(([scope]) => scope)).toEqual([
		{ installationId: 1, repo: "noresponse", permissions: { contents: "read" } },
		{ installationId: 1, repo: "noresponse-openapi-generation", permissions: { contents: "read" } },
	]);
	const fetches = fake.execute.mock.calls.filter(([, args]) => args.includes("fetch"));
	expect(fetches).toHaveLength(2);
	expect(fetches[1]?.[1].at(-1)).toBe("d".repeat(40));
	for (const [command, args, options] of fake.execute.mock.calls) {
		if (command === "git" && args.includes("fetch")) continue;
		expect(options.env.GIT_CONFIG_VALUE_0).toBeUndefined();
	}
	const smoke = fake.execute.mock.calls.find(([command]) => command === "bash");
	expect(smoke?.[2].env.NORESPONSE_SDKGEN_SOURCE).toMatch(/trusted-sdk-generator$/);
});
it("rejects a generator repository outside the trusted source before minting its credential", async () => {
	service();
	fake.repository = "https://github.com/unapproved/generator.git";
	await expect(productionSearch(repo, sha, options())).rejects.toMatchObject({
		payload: expect.objectContaining({ stage: "fetch_sdk_generator", status: "fail" }),
	});
	expect(fake.token).toHaveBeenCalledTimes(1);
	expect(fake.execute.mock.calls.some(([command]) => command === "bash")).toBe(false);
});

it("uploads the proof directory before deleting it and returns a bundle the host accepts", async () => {
	service();
	const proof = await productionSearch(repo, sha, options());
	expect(stored).toEqual([
		expect.objectContaining({ artifact: "search-summary.json", part: 0, parts: 1, content: expect.stringContaining('"pass"') }),
	]);
	expect(proof.bundle.artifacts).toEqual([expect.objectContaining({ name: "search-summary.json", evidence_ids: ["ev-1"] })]);
	expect(proof.bundle.observed_release_sha).toBe(sha);
	expect(bundleRefusal(proof.bundle, { stage: "production", sha })).toBeNull();
});
it("types a failed smoke as a product failure and still keeps its proof files", async () => {
	service();
	const smoke = fake.execute.getMockImplementation();
	fake.execute.mockImplementation(async (command: string, args: string[], opts: { env: Record<string, string> }) => {
		if (command !== "bash") return smoke?.(command, args, opts);
		await mkdir(opts.env.NR_PROD_SMOKE_DIR as string, { recursive: true });
		await writeFile(join(opts.env.NR_PROD_SMOKE_DIR as string, "search-summary.json"), JSON.stringify({ status: "fail" }));
		throw Object.assign(new Error("smoke failed"), { code: 3 });
	});
	const failure = await productionSearch(repo, sha, options()).catch((error: unknown) => error);
	expect(failure).toMatchObject({ failureClass: "product_failure", payload: { failure_class: "product_failure", stage: "production_smoke" } });
	expect(stored).toEqual([expect.objectContaining({ artifact: "search-summary.json" })]);
	expect(bundleRefusal((failure as { payload: { bundle: unknown } }).payload.bundle, { stage: "production", sha })).toMatch(/failure/);
});
it("types production running another build as a superseded release", async () => {
	service();
	vi.stubGlobal(
		"fetch",
		vi.fn(async () => Response.json({ build_version: "f".repeat(40) })),
	);
	await expect(productionSearch(repo, sha, options())).rejects.toMatchObject({
		failureClass: "superseded_release",
		payload: { bundle: expect.objectContaining({ observed_release_sha: "f".repeat(40), failure_class: "superseded_release" }) },
	});
});
