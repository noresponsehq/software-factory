import { describe, expect, it, vi } from "vitest";
import { Budget, upperBound } from "../app/connectors/budget.js";
import type { Lease } from "../app/connectors/lease.js";
import type { Claimed } from "../app/connectors/ledger.js";

describe("external resource charges", () => {
	it("rounds reservations upward to microdollars", () => {
		expect(upperBound(0.316, 3600)).toBe(0.316);
		expect(upperBound(0.316, 1)).toBe(0.000088);
		expect(() => upperBound(0, 1)).toThrow();
		expect(() => upperBound(1, Number.NaN)).toThrow();
	});
	it("does not return a launch permit until the durable journal accepts the ceiling", async () => {
		const claim: Claimed = {
			status: "claimed",
			run_id: "run",
			token: "test",
			expires_at: "later",
			state: { cleanup_only: false, phase: "research", version: 0, evidence_ids: [], resource_charges: [] },
		};
		const checkpoint = vi.fn().mockRejectedValue(new Error("budget exhausted"));
		const budget = new Budget(claim, { checkpoint } as unknown as Lease);
		await expect(budget.reserve("render1", "render", 0.316)).rejects.toThrow("budget exhausted");
		expect(checkpoint).toHaveBeenCalledWith({ resource_charges: [{ key: "render1", kind: "render", reserved_usd: 0.316, status: "reserved" }] });
	});
	it("will not launch again from a recovered ambiguous reservation", async () => {
		const claim: Claimed = {
			status: "claimed",
			run_id: "run",
			token: "test",
			expires_at: "later",
			state: {
				cleanup_only: false,
				phase: "research",
				version: 0,
				evidence_ids: [],
				resource_charges: [{ key: "render1", kind: "render", reserved_usd: 0.316, status: "reserved" }],
			},
		};
		const checkpoint = vi.fn();
		const budget = new Budget(claim, { checkpoint } as unknown as Lease);
		await expect(budget.reserve("render1", "render", 0.316)).rejects.toThrow("reconcile");
		expect(checkpoint).not.toHaveBeenCalled();
		expect(budget.charged()).toBe(0.316);
	});
});
