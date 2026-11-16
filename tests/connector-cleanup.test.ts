import { afterEach, expect, it, vi } from "vitest";
import { Lease } from "../app/connectors/lease.js";
import { type Claimed, Ledger, type State } from "../app/connectors/ledger.js";
import type { Sandbox } from "../app/sandbox/index.js";

const fake = vi.hoisted(() => ({
	terminate: vi.fn(async (_id: string) => {}),
	confirm: vi.fn(async (_id: string) => {}),
	open: vi.fn(),
	requests: [] as { action: string; body: Record<string, unknown> }[],
	state: {} as State,
}));
vi.mock("../app/config/index.js", async (original) => ({
	...(await original<typeof import("../app/config/index.js")>()),
	config: { connectors: { reserveUsd: 5, toolAllowanceUsd: 0.5 } },
	requireEnv: (key: string) => (key === "NR_LEDGER_URL" ? "https://ledger.invalid" : "offline-test"),
	requireRepo: () => ({ fullName: "acme/repo", owner: "acme", name: "repo", config: { verify: ["true"], baseBranch: "main" } }),
}));
vi.mock("../app/github/index.js", async (original) => ({
	...(await original<typeof import("../app/github/index.js")>()),
	githubFor: () => ({ getPermission: async () => "write" }),
}));
vi.mock("../app/sandbox/index.js", async (original) => ({
	...(await original<typeof import("../app/sandbox/index.js")>()),
	sandboxClient: () => ({ terminate: fake.terminate, confirmTerminated: fake.confirm }),
	openSandbox: fake.open,
}));
import { runConnector } from "../app/connectors/runtime.js";

const input = {
	repo: "acme/repo",
	installation_id: 1,
	actor: "tester",
	task: "offline",
	event_id: "e",
	connector: "github",
	linear_issue: "NOR-1436",
	condition_hash: "h",
	reserve_usd: 5,
	tool_allowance_usd: 0.5,
	lease_seconds: 3600,
};
const started = { key: "render-z", kind: "render_sandbox", status: "started" as const, resource_id: "owned-resource", reserved_usd: 0.316 };
function service(resources: State["resource_charges"], journalFails = false) {
	fake.requests.length = 0;
	fake.terminate.mockReset().mockResolvedValue();
	fake.confirm.mockReset().mockResolvedValue();
	fake.open.mockClear();
	fake.state = { cleanup_only: true, version: 1, phase: "research", resource_charges: resources, evidence_ids: [] };
	vi.stubGlobal(
		"fetch",
		vi.fn<typeof fetch>(async (url, options) => {
			const action = String(url).split("/").at(-1) ?? "";
			const body = JSON.parse(String(options?.body)) as Record<string, unknown>;
			fake.requests.push({ action, body });
			if (action === "finish") return Response.json({ status: body.outcome });
			if (action === "heartbeat") {
				const delta = body.resource_charges as State["resource_charges"] | undefined;
				if (delta?.some((resource) => resource.status !== "terminated")) return Response.json({ error: "needs_person" }, { status: 409 });
				if (delta && journalFails) return Response.json({ error: "version_conflict" }, { status: 409 });
				fake.state = {
					...fake.state,
					version: fake.state.version + 1,
					resource_charges: fake.state.resource_charges.map((r) => delta?.find((d) => d.key === r.key) ?? r),
				};
			}
			return Response.json({
				status: "claimed",
				run_id: "r1",
				token: "offline",
				expires_at: action === "claim" ? 0 : Date.now() + 3600000,
				state: fake.state,
			});
		}),
	);
}
afterEach(() => vi.unstubAllGlobals());

it("cleans known resources after an ambiguous reservation and retains unfinished ownership", async () => {
	service([{ key: "fly-a", kind: "fly_probe", status: "reserved", resource_id: null, reserved_usd: 0.01 }, started]);
	expect(await runConnector(input)).toMatchObject({ status: "cleanup_pending" });
	expect(fake.terminate).toHaveBeenCalledWith("owned-resource");
	expect(fake.confirm).toHaveBeenCalledWith("owned-resource");
	expect(fake.state.resource_charges[1]?.status).toBe("terminated");
	expect(fake.requests.some((r) => r.action === "finish")).toBe(false);
	expect(fake.open).not.toHaveBeenCalled();
});
it.each(["provider", "journal"])("continues provider cleanup after an earlier %s failure without settling", async (failure) => {
	service([{ ...started, key: "render-a", resource_id: "first-resource" }, started], failure === "journal");
	if (failure === "provider") fake.terminate.mockRejectedValueOnce(new Error("provider unavailable"));
	expect(await runConnector(input)).toMatchObject({ status: "cleanup_pending" });
	expect(fake.terminate.mock.calls).toEqual([["first-resource"], ["owned-resource"]]);
	expect(fake.confirm).toHaveBeenCalledWith("owned-resource");
	expect(fake.requests.some((r) => r.action === "finish")).toBe(false);
	expect(fake.open).not.toHaveBeenCalled();
});
it("settles a held run as blocked only after all known resources are terminated", async () => {
	service([started]);
	expect(await runConnector(input)).toMatchObject({ status: "blocked", reason: "needs_person" });
	expect(fake.terminate).toHaveBeenCalledWith("owned-resource");
	expect(fake.confirm).toHaveBeenCalledWith("owned-resource");
	expect(fake.state.resource_charges[0]?.status).toBe("terminated");
	expect(fake.requests.at(-1)).toMatchObject({ action: "finish", body: { outcome: "blocked" } });
	expect(fake.requests.some((r) => (r.body.resource_charges as State["resource_charges"] | undefined)?.some((d) => d.status === "reserved"))).toBe(
		false,
	);
	expect(fake.open).not.toHaveBeenCalled();
});
it("aborts explicit CAS loss and preserves provider cleanup when its journal write is fenced", async () => {
	const claim: Claimed = {
		status: "claimed",
		run_id: "r",
		token: "t",
		expires_at: Date.now() + 100000,
		state: { cleanup_only: false, phase: "research", version: 1, resource_charges: [], evidence_ids: [] },
	};
	const ledger = new Ledger("https://ledger.invalid", "offline", vi.fn<typeof fetch>().mockResolvedValue(new Response("", { status: 409 })));
	const lease = new Lease(ledger, claim, 3600);
	const exec = vi.fn(async () => ({ stdout: "", stderr: "", exitCode: 0 }));
	const terminated = vi.fn();
	const close = vi.fn(async () => {
		terminated();
		await lease.checkpoint();
	});
	const sandbox = lease.track({ exec, close } as unknown as Sandbox);
	await expect(lease.checkpoint()).rejects.toThrow("409");
	expect(lease.signal.aborted).toBe(true);
	expect(terminated).toHaveBeenCalledOnce();
	expect(() => sandbox.exec("ordinary offline command")).toThrow("lease lost");
	expect(exec).not.toHaveBeenCalled();
	await expect(lease.exclusive(async () => "allowed")).rejects.toThrow("lease lost");
	await lease.stop();
});

it("enforces an elapsed host deadline even before the timer callback can run", async () => {
	vi.useFakeTimers();
	const claim: Claimed = {
		status: "claimed",
		run_id: "r",
		token: "offline",
		expires_at: "later",
		state: { cleanup_only: false, phase: "research", version: 1, resource_charges: [], evidence_ids: [] },
	};
	const lease = new Lease(new Ledger("https://ledger.invalid", "offline"), claim, 3600, 1);
	const close = vi.fn(async () => {});
	const lateClose = vi.fn(async () => {});
	const action = vi.fn(async () => {});
	try {
		await lease.trackCleanup(close);
		vi.setSystemTime(Date.now() + 2000);
		await expect(lease.exclusive(action)).rejects.toThrow("lease lost");
		expect(lease.signal.aborted).toBe(true);
		expect(close).toHaveBeenCalledOnce();
		expect(action).not.toHaveBeenCalled();
		await expect(lease.trackCleanup(lateClose)).rejects.toThrow("lease lost");
		expect(lateClose).toHaveBeenCalledOnce();
	} finally {
		await lease.stop();
		vi.useRealTimers();
	}
});
