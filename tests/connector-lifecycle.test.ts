import { describe, expect, it, vi } from "vitest";
import type { Claimed } from "../app/connectors/ledger.js";
import { advance, type LifecyclePorts } from "../app/connectors/lifecycle.js";

const head = "a".repeat(40);
const merge = "b".repeat(40);
function setup() {
	const claim: Claimed = {
		status: "claimed",
		run_id: "r1",
		token: "run-token",
		expires_at: "later",
		state: { cleanup_only: false, phase: "research", version: 0, resource_charges: [], evidence_ids: [] },
	};
	const ports: LifecyclePorts = {
		checkpoint: vi.fn(async () => {}),
		implement: vi.fn(async () => ({ head, evidence: ["implementation"] })),
		verify: vi.fn(async () => ({ passed: true, head, evidence: ["fresh-verifier"], reason: "" })),
		ready: vi.fn(async () => ({ number: 1, url: "https://github.com/o/r/pull/1" })),
		disarm: vi.fn(async () => {}),
		autoMerge: vi.fn(async () => {}),
		pull: vi.fn(async () => ({ kind: "pending" as const })),
		production: vi.fn(async () => ({ status: "passed" as const, sha: merge, evidence: ["release", "search"] })),
		closeLinear: vi.fn(async () => {}),
		block: vi.fn(async () => {}),
	};
	return { claim, ports };
}
describe("connector lifecycle", () => {
	it("only closes Linear after independent review, merge and matching production proof", async () => {
		const { claim, ports } = setup();
		expect(await advance(claim, ports, 1)).toBe("waiting");
		expect(ports.autoMerge).toHaveBeenCalledWith(1, head);
		expect(ports.closeLinear).not.toHaveBeenCalled();
		vi.mocked(ports.pull).mockResolvedValue({ kind: "merged", head, merge });
		expect(await advance(claim, ports, 1)).toBe("completed");
		expect(ports.implement).toHaveBeenCalledTimes(1);
		expect(claim.state.phase).toBe("production_verified");
		expect(ports.closeLinear).toHaveBeenCalledWith(["implementation", "fresh-verifier", "release", "search"]);
	});
	it.each(["stale", "missing", "failed"])("refuses %s independent proof before opening a PR", async (failure) => {
		const { claim, ports } = setup();
		vi.mocked(ports.verify).mockResolvedValue({
			passed: failure !== "failed",
			head: failure === "stale" ? merge : head,
			evidence: failure === "missing" ? [] : ["proof"],
			reason: "verification failed",
		});
		expect(await advance(claim, ports, 1)).toBe("blocked");
		expect(ports.ready).not.toHaveBeenCalled();
		expect(ports.closeLinear).not.toHaveBeenCalled();
		expect(ports.implement).toHaveBeenCalledTimes(2);
	});
	it("refuses a merge of an unreviewed head", async () => {
		const { claim, ports } = setup();
		await advance(claim, ports, 0);
		vi.mocked(ports.pull).mockResolvedValue({ kind: "merged", head: merge, merge });
		expect(await advance(claim, ports, 0)).toBe("blocked");
		expect(ports.production).not.toHaveBeenCalled();
	});
	it.each(["failed", "pending", "wrong_sha", "no_evidence"])("never closes on %s release", async (failure) => {
		const { claim, ports } = setup();
		claim.state = { cleanup_only: false, phase: "release", version: 4, merge_sha: merge, resource_charges: [], evidence_ids: [] };
		vi.mocked(ports.production).mockResolvedValue({
			status: failure === "pending" ? "pending" : failure === "failed" ? "failed" : "passed",
			sha: failure === "wrong_sha" ? head : merge,
			evidence: failure === "no_evidence" ? [] : ["proof"],
		});
		expect(await advance(claim, ports, 0)).toBe(failure === "pending" ? "waiting" : "blocked");
		expect(ports.closeLinear).not.toHaveBeenCalled();
	});
	it("disarms auto-merge before persisting repair and before updating a repaired branch", async () => {
		const { claim, ports } = setup();
		await advance(claim, ports, 0);
		const order: string[] = [];
		vi.mocked(ports.pull).mockResolvedValue({ kind: "repair", reason: "red CI" });
		vi.mocked(ports.disarm).mockImplementation(async () => {
			order.push("disarm");
		});
		vi.mocked(ports.checkpoint).mockImplementation(async () => {
			order.push("checkpoint");
		});
		await advance(claim, ports, 0);
		expect(order).toEqual(["disarm", "checkpoint"]);
		expect(claim.state.repair_reason).toBe("red CI");
		vi.mocked(ports.disarm).mockRejectedValue(new Error("disarm failed"));
		vi.mocked(ports.implement).mockClear();
		await expect(advance(claim, ports, 0)).rejects.toThrow("disarm failed");
		expect(ports.implement).not.toHaveBeenCalled();
	});

	it("stops before work when checkpoint loses its lease", async () => {
		const { claim, ports } = setup();
		vi.mocked(ports.checkpoint).mockRejectedValue(new Error("lease conflict"));
		await expect(advance(claim, ports, 0)).rejects.toThrow("lease conflict");
		expect(ports.implement).not.toHaveBeenCalled();
	});
});
