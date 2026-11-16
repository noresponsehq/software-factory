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
it("fetches the pinned private generator with a repository-scoped read credential removed before execution", async () => {
	service();
	expect(await productionSearch(repo, sha)).toMatchObject({ status: "pass", checks: 2 });
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
	await expect(productionSearch(repo, sha)).rejects.toMatchObject({
		payload: expect.objectContaining({ stage: "fetch_sdk_generator", status: "fail" }),
	});
	expect(fake.token).toHaveBeenCalledTimes(1);
	expect(fake.execute.mock.calls.some(([command]) => command === "bash")).toBe(false);
});
