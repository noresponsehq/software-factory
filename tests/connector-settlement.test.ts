import { afterEach, expect, it, vi } from "vitest";
import type { LifecyclePorts } from "../app/connectors/lifecycle.js";
import type { State } from "../app/connectors/ledger.js";

const fake = vi.hoisted(() => ({
	state: {} as State,
	finishes: [] as { outcome: string }[],
	result: "blocked" as "blocked" | "completed" | "waiting" | "prepare",
	unresolved: true,
	complete: vi.fn(async () => true),
	terminate: vi.fn(async () => {}),
	open: vi.fn(),
}));
vi.mock("../app/config/index.js", async (original) => ({
	...(await original<typeof import("../app/config/index.js")>()),
	config: { connectors: { reserveUsd: 8, toolAllowanceUsd: 0.5 } },
	requireEnv: (key: string) => (key === "NR_LEDGER_URL" ? "https://ledger.invalid" : "offline"),
	requireRepo: () => ({ fullName: "acme/repo", config: { verify: ["true"], baseBranch: "main" } }),
}));
vi.mock("../app/github/index.js", () => ({ githubFor: () => ({ getPermission: async () => "write" }) }));
vi.mock("../app/connectors/accounting.js", () => ({ accountDaily: async () => {}, costPolicy: () => ({ sandboxTrafficUsd: 0.2 }) }));
vi.mock("../app/connectors/linear.js", () => ({
	Linear: class {
		complete = fake.complete;
	},
}));
vi.mock("../app/sandbox/index.js", async (original) => ({
	...(await original<typeof import("../app/sandbox/index.js")>()),
	openSandbox: fake.open,
	sandboxClient: () => ({ terminate: fake.terminate, confirmTerminated: async () => {} }),
}));
vi.mock("../app/connectors/lifecycle.js", () => ({
	advance: async (_claim: unknown, ports: LifecyclePorts) => {
		if (fake.result === "prepare") return ports.implement();
		await ports.checkpoint({
			resource_charges: [{ key: "render-live", kind: "render_sandbox", status: "started", resource_id: "owned", reserved_usd: 0.516 }],
		});
		await withSandbox(
			async () => ({
				id: "owned",
				exec: async () => ({ stdout: "", stderr: "", exitCode: 0 }),
				upload: async () => {},
				download: async () => Buffer.alloc(0),
				close: async () => {
					if (fake.unresolved) throw new Error("provider unavailable");
					await ports.checkpoint({
						resource_charges: [{ key: "render-live", kind: "render_sandbox", status: "terminated", resource_id: "owned", reserved_usd: 0.516 }],
					});
				},
			}),
			async () => false,
		);
		if (fake.result === "blocked") await ports.block("Independent verification failed");
		if (fake.result === "completed") {
			await ports.checkpoint({ phase: "production_verified", merge_sha: "a".repeat(40) });
			await ports.closeLinear(["proof"]);
		}
		return fake.result;
	},
}));
import { withSandbox } from "../app/sandbox/index.js";
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
	reserve_usd: 8,
	tool_allowance_usd: 0.5,
	lease_seconds: 3600,
};
function service() {
	fake.state = { version: 0, phase: "research", resource_charges: [], evidence_ids: [], cleanup_only: false };
	fake.finishes = [];
	fake.complete.mockReset().mockResolvedValue(true);
	fake.terminate.mockClear();
	fake.unresolved = true;
	vi.stubGlobal(
		"fetch",
		vi.fn<typeof fetch>(async (url, opts) => {
			const action = String(url).split("/").at(-1);
			const body = JSON.parse(String(opts?.body));
			if (action === "finish") {
				fake.finishes.push(body);
				return Response.json({ status: body.outcome });
			}
			if (action === "heartbeat") {
				if (body.phase) fake.state.phase = body.phase;
				if (body.merge_sha) fake.state.merge_sha = body.merge_sha;
				for (const resource of body.resource_charges ?? []) {
					const at = fake.state.resource_charges.findIndex((r) => r.key === resource.key);
					if (at < 0) fake.state.resource_charges.push(resource);
					else fake.state.resource_charges[at] = resource;
				}
				fake.state.version++;
			}
			return Response.json(
				{ status: "claimed", run_id: "r", token: "offline", expires_at: "2099-01-01", state: fake.state },
				{ status: action === "claim" ? 201 : 200 },
			);
		}),
	);
}
afterEach(() => {
	vi.useRealTimers();
	vi.unstubAllGlobals();
});
it.each(["blocked", "completed", "waiting"] as const)("retains unfinished cleanup on normal %s lifecycle result", async (result) => {
	service();
	fake.result = result;
	expect(await runConnector(input)).toMatchObject({ status: "cleanup_pending" });
	expect(fake.finishes).toEqual([]);
	expect(fake.complete).not.toHaveBeenCalled();
});
it.each(["blocked", "completed"] as const)("settles %s only after provider termination is journalled", async (result) => {
	service();
	fake.result = result;
	fake.unresolved = false;
	expect(await runConnector(input)).toMatchObject({ status: result });
	expect(fake.finishes).toEqual([expect.objectContaining({ outcome: result })]);
	expect(fake.complete).toHaveBeenCalledTimes(result === "completed" ? 1 : 0);
});
it("settles durably before issue closure and leaves a failed closure replayable", async () => {
	service();
	fake.result = "completed";
	fake.unresolved = false;
	fake.complete.mockImplementationOnce(async () => {
		expect(fake.finishes).toEqual([expect.objectContaining({ outcome: "completed" })]);
		throw new Error("Linear unavailable");
	});
	expect(await runConnector(input)).toMatchObject({ status: "completion_pending" });
	expect(fake.finishes).toHaveLength(1);
	vi.mocked(fetch).mockResolvedValueOnce(Response.json({ status: "completed", state: { merge_sha: "a".repeat(40) } }));
	expect(await runConnector(input)).toMatchObject({ status: "completed" });
	expect(fake.complete).toHaveBeenCalledTimes(2);
	expect(fake.finishes).toHaveLength(1);
});
it("terminates a restored sandbox during preparation when ownership is lost", async () => {
	service();
	fake.result = "prepare";
	vi.useFakeTimers();
	let ready!: () => void;
	const preparing = new Promise<void>((resolve) => {
		ready = resolve;
	});
	fake.open.mockImplementation(async (_repo, _ref, deps) => {
		await deps.onCreated("preparing");
		ready();
		await new Promise((_resolve, reject) => deps.signal.addEventListener("abort", () => reject(new Error("lease lost")), { once: true }));
	});
	const operation = runConnector(input);
	await preparing;
	vi.mocked(fetch).mockResolvedValueOnce(new Response("", { status: 409 }));
	await vi.advanceTimersByTimeAsync(30000);
	expect(await operation).toMatchObject({ status: "ownership_lost" });
	expect(fake.terminate).toHaveBeenCalledWith("preparing");
	expect(fake.finishes).toEqual([]);
});
