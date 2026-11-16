import { describe, expect, it, vi } from "vitest";
import { accountDaily } from "../app/connectors/accounting.js";
import { Ledger } from "../app/connectors/ledger.js";

const state = { phase: "research", version: 0, resource_charges: [], evidence_ids: [], cleanup_only: false };
const envelope = { status: "claimed", run_id: "services", token: "offline", expires_at: "2099-01-01", state };
const now = new Date("2026-11-17T00:00:00Z");
function service(responses: Response[]) {
	const request = vi.fn<typeof fetch>();
	for (const response of responses) request.mockResolvedValueOnce(response);
	return { request, ledger: new Ledger("https://ledger.test", "operator", request) };
}
const empty = () => Response.json({ runs: [] });
describe("daily admission accounting", () => {
	it("journals baseline, retained storage and dispatch before settling conservative charges", async () => {
		const { ledger, request } = service([
			empty(),
			Response.json(envelope, { status: 201 }),
			Response.json(envelope),
			Response.json({ status: "blocked" }),
		]);
		await accountDaily(ledger, now);
		const bodies = request.mock.calls.map(([, opts]) => (opts?.body ? JSON.parse(String(opts.body)) : null));
		expect(bodies[1]).toMatchObject({ connector: "factory_services", reserve_usd: 2.5, tool_allowance_usd: 0 });
		expect(bodies[2].resource_charges).toEqual([
			{ key: "baseline", kind: "service_baseline", reserved_usd: 1, status: "reserved" },
			{ key: "storage", kind: "retained_storage", reserved_usd: 0.5, status: "reserved" },
			{ key: "dispatch", kind: "dispatch_overhead", reserved_usd: 1, status: "reserved" },
		]);
		expect(bodies[3]).toMatchObject({ charged_usd: 2.5, cost_basis: "reserved_upper_bound", outcome: "blocked" });
	});
	it("recognizes the actual terminal replay envelope without new journal writes", async () => {
		const { ledger, request } = service([
			empty(),
			Response.json({
				...envelope,
				token: undefined,
				status: "blocked",
				state: { ...state, reason: "Daily factory service, dispatch and storage allowance accounted" },
			}),
		]);
		await accountDaily(ledger, now);
		expect(request).toHaveBeenCalledTimes(2);
	});
	it("does not take over active replay or permit dispatch when the shared cap refuses admission", async () => {
		for (const response of [
			Response.json({ ...envelope, token: undefined }),
			Response.json({ status: "blocked", reason: "budget" }, { status: 409 }),
		]) {
			const { ledger, request } = service([empty(), response]);
			await expect(accountDaily(ledger, now)).rejects.toThrow();
			expect(request).toHaveBeenCalledTimes(2);
		}
	});
	it("does not settle when the journal rejects the allocation", async () => {
		const { ledger, request } = service([empty(), Response.json(envelope, { status: 201 }), new Response("", { status: 409 })]);
		await expect(accountDaily(ledger, now)).rejects.toThrow("409");
		expect(request).toHaveBeenCalledTimes(3);
	});
	it("rotates expired ownership before accounting an interrupted previous day", async () => {
		const previous = { ...envelope, expires_at: "2000-01-01", state: { ...state, connector: "factory_services", event_id: "old", reserve_usd: 2.5 } };
		const { ledger, request } = service([
			Response.json({ runs: [previous] }),
			Response.json({ ...envelope, token: "rotated" }),
			Response.json({ status: "blocked" }),
			Response.json({ status: "blocked", reason: "budget" }, { status: 409 }),
		]);
		await expect(accountDaily(ledger, now)).rejects.toThrow("admission refused");
		expect(JSON.parse(String(request.mock.calls[1]?.[1]?.body))).toMatchObject({ recover: true, token: "offline" });
		expect(JSON.parse(String(request.mock.calls[2]?.[1]?.body))).toMatchObject({ token: "rotated", charged_usd: 2.5 });
	});
});
