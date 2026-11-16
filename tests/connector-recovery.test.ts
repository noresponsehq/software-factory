import { describe, expect, it, vi } from "vitest";
import { drainHealth } from "../app/connectors/health.js";
import { Ledger } from "../app/connectors/ledger.js";

const state = { cleanup_only: false, version: 2, phase: "ci", resource_charges: [], evidence_ids: [] };
const input = {
	event_id: "e",
	connector: "github",
	linear_issue: "NOR-1436",
	condition_hash: "h",
	reserve_usd: 5,
	tool_allowance_usd: 0.5,
	lease_seconds: 100,
};
const envelope = { status: "claimed", run_id: "r1", expires_at: "2099-01-01T00:00:00Z", state };
describe("factory ownership and durable dispatch", () => {
	it("never owns or renews an active tokenless replay", async () => {
		const request = vi.fn<typeof fetch>().mockResolvedValue(Response.json(envelope, { status: 200 }));
		const ledger = new Ledger("https://ledger.test", "operator", request);
		const replay = await ledger.claim(input);
		expect(await ledger.own(replay, 100)).toBeNull();
		expect(request).toHaveBeenCalledTimes(1);
	});
	it("owns a fresh 201 and acquires expired replay exclusively before use", async () => {
		const request = vi
			.fn<typeof fetch>()
			.mockResolvedValueOnce(Response.json({ ...envelope, token: "fresh" }, { status: 201 }))
			.mockResolvedValueOnce(Response.json({ ...envelope, expires_at: "2000-01-01T00:00:00Z", token: "expired" }))
			.mockResolvedValueOnce(Response.json({ ...envelope, token: "rotated", state: { ...state, version: 3 } }));
		const ledger = new Ledger("https://ledger.test", "operator", request);
		expect((await ledger.own(await ledger.claim(input), 100))?.token).toBe("fresh");
		expect((await ledger.own(await ledger.claim(input), 100))?.token).toBe("rotated");
		expect(JSON.parse(request.mock.calls[2]?.[1]?.body as string)).toMatchObject({ recover: true, token: "expired", expected_version: 2 });
	});
	it("fails ownership on a competing recovery CAS", async () => {
		const ledger = new Ledger("https://ledger.test", "operator", vi.fn<typeof fetch>().mockResolvedValue(new Response("conflict", { status: 409 })));
		await expect(
			ledger.own({ ...envelope, status: "claimed", state: { ...state, phase: "ci" }, fresh: false, expires_at: "2000-01-01", token: "expired" }, 100),
		).rejects.toThrow("409");
	});
	it("drains filtered healthy pages before the following failure and commits only after dispatch", async () => {
		const calls: unknown[] = [];
		const ledger = {
			call: vi.fn(async (path: string, body?: unknown) => {
				calls.push([path, body]);
				if (path === "cursor") return { after: body ? 0 : 10 };
				if (path === "events?after=10") return { events: [], next: 110 };
				if (path === "events?after=110")
					return { events: [{ event_id: "health:111", rev: 111, connector: "github", condition_hash: "h" }], next: 111 };
				return { events: [], next: 111 };
			}),
		};
		expect(
			await drainHealth(ledger, async (event) => {
				calls.push(["dispatch", event.rev]);
			}),
		).toBe(111);
		expect(calls).toContainEqual(["events?after=110", undefined]);
		expect(calls.indexOf(calls.find((c) => Array.isArray(c) && c[0] === "dispatch"))).toBeLessThan(
			calls.findIndex((c) => Array.isArray(c) && c[0] === "cursor" && (c[1] as { after: number })?.after === 111),
		);
	});
	it("leaves the durable cursor unchanged on failed dispatch", async () => {
		const call = vi.fn(async (path: string) =>
			path === "cursor" ? { after: 0 } : { events: [{ event_id: "health:1", rev: 1, connector: "github", condition_hash: "h" }], next: 1 },
		);
		await expect(
			drainHealth({ call }, async () => {
				throw new Error("dispatch failed");
			}),
		).rejects.toThrow("dispatch failed");
		expect(call.mock.calls).toEqual([["cursor"], ["events?after=0"]]);
	});
});
