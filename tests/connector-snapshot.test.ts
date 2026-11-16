import { afterEach, expect, it, vi } from "vitest";
import type { State } from "../app/connectors/ledger.js";

const fake = vi.hoisted(() => ({ events: [] as string[], state: {} as State, terminate: vi.fn(async (_id: string) => {}), build: vi.fn() }));
vi.mock("../app/config/index.js", async (original) => ({
	...(await original<typeof import("../app/config/index.js")>()),
	requireEnv: (key: string) => (key === "NR_LEDGER_URL" ? "https://ledger.invalid" : "offline"),
}));
vi.mock("../app/connectors/accounting.js", async (original) => ({
	...(await original<typeof import("../app/connectors/accounting.js")>()),
	accountDaily: async () => {},
}));
vi.mock("../app/sandbox/index.js", async (original) => ({
	...(await original<typeof import("../app/sandbox/index.js")>()),
	sandboxClient: () => ({ terminate: fake.terminate, confirmTerminated: async () => {} }),
	buildSnapshot: fake.build,
}));

import { requireRepo } from "../app/config/index.js";
import { setupSnapshot } from "../app/connectors/setup.js";

const repo = requireRepo("acme/widget", 1);
const sha = "a".repeat(40);
function service(resources: State["resource_charges"] = [], held = false) {
	fake.events = [];
	fake.terminate.mockClear();
	fake.state = { phase: "research", version: 0, resource_charges: resources, evidence_ids: [], cleanup_only: held };
	fake.build.mockReset().mockImplementation(async (_client, _repo, _sha, deps) => {
		fake.events.push("create");
		await deps.allocation.started("owned");
		await deps.allocation.terminated("owned");
		return { id: "snapshot-1" };
	});
	vi.stubGlobal(
		"fetch",
		vi.fn<typeof fetch>(async (url, opts) => {
			const action = String(url).split("/").at(-1);
			const body = JSON.parse(String(opts?.body));
			fake.events.push(String(action));
			if (action === "heartbeat") {
				for (const resource of body.resource_charges ?? []) {
					fake.events.push(`${resource.kind}:${resource.status}`);
					const at = fake.state.resource_charges.findIndex((r) => r.key === resource.key);
					if (at < 0) fake.state.resource_charges.push(resource);
					else fake.state.resource_charges[at] = resource;
				}
				fake.state.version++;
			}
			if (action === "finish") return Response.json({ status: body.outcome });
			return Response.json(
				{ status: "claimed", run_id: "setup", token: "offline", expires_at: "2099-01-01", state: fake.state },
				{ status: action === "claim" ? 201 : 200 },
			);
		}),
	);
}
afterEach(() => vi.unstubAllGlobals());
it("admits builder and host costs before provider creation and settles only after termination", async () => {
	service();
	expect(await setupSnapshot(repo, sha)).toMatchObject({ snapshotId: "snapshot-1", sha });
	expect(fake.events.indexOf("render_builder:reserved")).toBeLessThan(fake.events.indexOf("create"));
	expect(fake.events.indexOf("setup_workflow:reserved")).toBeLessThan(fake.events.indexOf("create"));
	expect(fake.events.indexOf("render_builder:terminated")).toBeLessThan(fake.events.indexOf("finish"));
});
it("cleans all known builders after an ambiguous creation without settling or rebuilding", async () => {
	service([
		{ key: "unknown", kind: "render_builder", reserved_usd: 0.5, status: "reserved" },
		{ key: "known", kind: "render_builder", reserved_usd: 0.5, status: "started", resource_id: "owned" },
	]);
	await expect(setupSnapshot(repo, sha)).rejects.toThrow("inspection");
	expect(fake.terminate).toHaveBeenCalledWith("owned");
	expect(fake.events).not.toContain("finish");
	expect(fake.build).not.toHaveBeenCalled();
});
it("cleans a held snapshot run and settles blocked without creating new resources", async () => {
	service([{ key: "known", kind: "render_builder", reserved_usd: 0.5, status: "started", resource_id: "owned" }], true);
	await expect(setupSnapshot(repo, sha)).rejects.toThrow("inspection");
	expect(fake.terminate).toHaveBeenCalledWith("owned");
	expect(fake.events).toContain("finish");
	expect(fake.build).not.toHaveBeenCalled();
});

it.each(["heartbeat", "deadline"])("cancels an in-flight builder after %s ownership loss", async (failure) => {
	service();
	vi.useFakeTimers();
	let started!: () => void;
	const ready = new Promise<void>((resolve) => {
		started = resolve;
	});
	let release!: () => void;
	const paused = new Promise<void>((resolve) => {
		release = resolve;
	});
	fake.build.mockImplementation(async (_client, _repo, _sha, deps) => {
		await deps.allocation.started("owned");
		started();
		await paused;
		deps.signal?.throwIfAborted();
		fake.events.push("post-loss-provider-effect");
		await deps.allocation.terminated("owned");
		return { id: "snapshot-1" };
	});
	const operation = setupSnapshot(repo, sha).catch((error) => error);
	try {
		await ready;
		if (failure === "heartbeat") vi.mocked(fetch).mockResolvedValueOnce(new Response("", { status: 409 }));
		await vi.advanceTimersByTimeAsync(failure === "heartbeat" ? 30000 : 3600000);
		expect(fake.terminate).toHaveBeenCalledWith("owned");
	} finally {
		release();
		await operation;
		vi.useRealTimers();
	}
	expect(fake.events).not.toContain("post-loss-provider-effect");
	expect(fake.events).not.toContain("finish");
});
