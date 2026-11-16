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
	requireEnv: (name: string) => name === "NR_LEDGER_URL" ? "https://ledger.invalid" : name === "NR_FACTORY_OPERATOR_TOKEN" ? "offline-operator-token" : "offline-search-key",
}));
import type { RepoContext } from "../app/config/index.js";
import { bundleRefusal } from "../app/connectors/bundle.js";
import { groupPersonLookup, productionVerify, productionSearch } from "../app/connectors/production.js";

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

const fixtureSecret = "owned.synthetic@example.invalid";
const sealedRecipe = {
 connector: "firefox_email", behaviour: "email proof",
 fixtures: [{ ref: "sealed.present", identifier: "email", control: { connector: "firefox_email", variant: "present", rev: 42 } }],
 requires: { session: false, route: null }, operation: { kind: "group_person_lookup", fixture: "sealed.present" },
 expect: { execution: "found", fields: ["name"] }, observe: { ledger_revision: 40 }, uncovered: [],
};
const sealedControl = {
 connector: "firefox_email", variant: "present", rev: 42, by: "email", found: true, value: fixtureSecret,
 region: null, subject: { field: "name", value: "Synthetic Person" }, expected: {},
 provenance: { kind: "supplied_control", source: "offline" }, verified_at: "2026-11-16T00:00:00Z",
 fresh_until: "2099-12-16T00:00:00Z", stale: false, written_by: "operator", written_role: "operator",
};
const fakeHttp = (recipe = sealedRecipe) => ({ json: async () => ({ content: Buffer.from(JSON.stringify(recipe)).toString("base64"), encoding: "base64" }) });
function transport(control = sealedControl, revision = 42) {
 service();
 const baseExec = fake.execute.getMockImplementation();
 fake.execute.mockImplementation(async (command, args, opts) => command === "fly" ? { stdout: JSON.stringify({ ledger: { rev: revision } }), stderr: "" } : baseExec?.(command, args, opts));
 const calls: { url: string; method: string; body: unknown; auth: string | null; redirect?: RequestRedirect }[] = [];
 vi.stubGlobal("fetch", vi.fn(async (url: string, init: RequestInit = {}) => {
  const method = init.method ?? "GET";
  const body = init.body ? JSON.parse(String(init.body)) : null;
  calls.push({ url, method, body, auth: new Headers(init.headers).get("authorization"), redirect: init.redirect });
  if (url.endsWith("/version")) return Response.json({ build_version: sha });
  if (url.endsWith("/healthz")) return Response.json({ ledger: { rev: revision } });
  if (url.endsWith("/ledger/controls/firefox_email")) return Response.json({ connector: "firefox_email", controls: [control] });
  if (url.endsWith("/v1/groups") && method === "POST") return Response.json({ id: "g1" });
  if (url.endsWith("/v1/groups/g1/people") && method === "POST") return Response.json({ items: [{ id: "p1" }] });
  if (url.endsWith("/v1/groups/g1/people/p1")) return Response.json({ lookup: { checks: [{ identifier: "email", status: "found", answered: 1, unanswered: [] }], records: [{ source: { connector: "firefox_email" }, fields: [{ field: "name", value: "Synthetic Person" }, { field: "email", value: fixtureSecret }] }] } });
  if (url.endsWith("/v1/people/p1") && method === "DELETE") return new Response(null, { status: 204 });
  throw new Error(`Unexpected offline transport ${method} ${url}`);
 }));
 return calls;
}
it("independent: production resolves sealed control via the operator transport and leaves only reference hashes in evidence", async () => {
 const calls = transport();
 const result = await productionVerify(repo, fakeHttp() as never, sha, "firefox_email", options());
 expect(result).toMatchObject({ status: "pass", ledger_revision: { required: 42, api: 42, worker: 42 } });
 const ledger = calls.filter(c => c.url.includes("/ledger/controls/"));
 expect(ledger).toEqual([expect.objectContaining({ method: "GET", auth: "Bearer offline-operator-token", redirect: "error" })]);
 const sent = calls.filter(c => JSON.stringify(c).includes(fixtureSecret));
 expect(sent).toEqual([expect.objectContaining({ auth: "Bearer offline-search-key", method: "POST", url: "https://api.noresponse.org/v1/groups/g1/people", body: { people: [{ email: fixtureSecret }] } })]);
 expect(JSON.stringify(result)).not.toContain(fixtureSecret);
 expect(JSON.stringify(stored)).not.toContain(fixtureSecret);
 expect(result.bundle.fixtures).toEqual([expect.objectContaining({ name: "control:firefox_email:present:42" })]);
});
it("independent: production refuses stale control before creating a public person", async () => {
 const calls = transport({ ...sealedControl, stale: true });
 const failure = await productionVerify(repo, fakeHttp() as never, sha, "firefox_email", options()).catch(e => e);
 expect(failure).toMatchObject({ payload: { reason: "fixture_unresolved" } });
 expect(calls.some(c => c.method === "POST")).toBe(false);
 expect(JSON.stringify(failure)).not.toContain(fixtureSecret);
});
it("independent: production requires the higher control revision before lookup", async () => {
 vi.useFakeTimers({ toFake: ["Date", "setTimeout"] });
 try {
  const calls = transport(sealedControl, 41);
  const pending = productionVerify(repo, fakeHttp() as never, sha, "firefox_email", options()).catch(e => e);
  await vi.runAllTimersAsync();
  const failure = await pending;
  expect(failure).toMatchObject({ payload: { reason: "ledger_revision_not_observed", required: 42, api: 41, worker: 41 } });
  expect(calls.some(c => c.url.includes("/ledger/controls/") || c.method === "POST")).toBe(false);
 } finally { vi.useRealTimers(); }
});
it("independent: raw email fixtures are refused at the production recipe boundary", async () => {
 const calls = transport();
 const raw = { ...sealedRecipe, fixtures: [{ ref: "sealed.present", identifier: "email", value: fixtureSecret }] };
 const failure = await productionVerify(repo, fakeHttp(raw as never) as never, sha, "firefox_email", options()).catch(e => e);
 expect(failure).toMatchObject({ payload: { reason: "acceptance_recipe_missing" } });
 expect(calls).toHaveLength(0);
 expect(JSON.stringify(failure)).not.toContain(fixtureSecret);
});
it("independent: public error transport cannot leak the resolved identifier", async () => {
 const calls = transport();
 const baseFetch = vi.mocked(fetch).getMockImplementation();
 vi.stubGlobal("fetch", vi.fn(async (url, init) => {
  if (String(url).endsWith("/v1/groups/g1/people")) throw new Error(`provider rejected ${fixtureSecret}`);
  return baseFetch?.(url, init);
 }));
 const failure = await productionVerify(repo, fakeHttp() as never, sha, "firefox_email", options()).catch(e => e);
 expect(calls.some(c => c.url.includes("/ledger/controls/"))).toBe(true);
 expect(String(failure)).not.toContain(fixtureSecret);
});
it("independent: unanswered-source evidence cannot leak the resolved identifier", async () => {
 transport();
 const baseFetch = vi.mocked(fetch).getMockImplementation();
 vi.stubGlobal("fetch", vi.fn(async (url, init) => {
  if (String(url).endsWith("/v1/groups/g1/people/p1")) return Response.json({ lookup: { checks: [{ identifier: "email", status: "failed", answered: 0, unanswered: [{ connector: "firefox_email", reason: `provider rejected ${fixtureSecret}` }] }], records: [] } });
  return baseFetch?.(url, init);
 }));
 const failure = await productionVerify(repo, fakeHttp() as never, sha, "firefox_email", options()).catch(e => e);
 expect(failure).toMatchObject({ payload: { reason: "connector_unanswered" } });
 expect(JSON.stringify(failure)).not.toContain(fixtureSecret);
});
it("independent: expiry while fetching a control is rejected before public lookup", async () => {
 vi.useFakeTimers({ toFake: ["Date"] });
 const start = Date.parse("2026-11-17T00:00:00Z");
 vi.setSystemTime(start);
 try {
  transport();
  const acceptance = await import("../app/connectors/acceptance.js");
  const recipe = acceptance.AcceptanceRecipe.parse(sealedRecipe);
  await expect(groupPersonLookup(recipe, async () => {}, async () => {
   vi.setSystemTime(start + 2_000);
   return [{ ...sealedControl, fresh_until: new Date(start + 1_000).toISOString() }];
  })).rejects.toMatchObject({ payload: { reason: "fixture_unresolved" } });
 } finally { vi.useRealTimers(); }
});
it("independent: phone controls reach only the public phone input", async () => {
 const calls = transport();
 const acceptance = await import("../app/connectors/acceptance.js");
 const recipe = acceptance.AcceptanceRecipe.parse({ ...sealedRecipe, fixtures: [{ ...sealedRecipe.fixtures[0], identifier: "phone" }] });
 await groupPersonLookup(recipe, async () => {}, async () => [{ ...sealedControl, by: "phone", value: "+14155550123" }]);
 expect(calls.find(c => c.url.endsWith("/v1/groups/g1/people"))?.body).toEqual({ people: [{ phone: "+14155550123" }] });
});
it("independent: public usernames retain platform selection without reading controls", async () => {
 const calls = transport();
 const acceptance = await import("../app/connectors/acceptance.js");
 const recipe = acceptance.AcceptanceRecipe.parse({ ...sealedRecipe, fixtures: [{ ref: "sealed.present", identifier: "username", platform: "github", value: "octocat" }] });
 const controls = vi.fn(async () => { throw new Error("must not read controls"); });
 await groupPersonLookup(recipe, async () => {}, controls);
 expect(calls.find(c => c.url.endsWith("/v1/groups/g1/people"))?.body).toEqual({ people: [{ handles: [{ platform: "github", handle: "octocat" }] }] });
 expect(controls).not.toHaveBeenCalled();
});
