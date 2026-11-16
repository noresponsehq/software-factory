import { describe, expect, it, vi } from "vitest";
import { FactoryAcceptance, Ledger } from "../app/connectors/ledger.js";
import { Linear } from "../app/connectors/linear.js";

const merge = "a".repeat(40);
describe("factory completion authority", () => {
	it("uses the operator route and validates its response", async () => {
		const request = vi.fn<typeof fetch>().mockResolvedValue(Response.json({ owned: true, accepted: true, merge_sha: merge }));
		expect(await new Ledger("https://ledger.invalid", "offline", request).acceptance("NOR-1436")).toEqual({ owned: true, accepted: true, merge_sha: merge });
		expect(request).toHaveBeenCalledWith("https://ledger.invalid/ledger/factory/acceptance?linear_issue=NOR-1436", expect.objectContaining({ headers: expect.objectContaining({ Authorization: "Bearer offline" }) }));
		for (const value of [{ owned: true, accepted: true }, { owned: true, accepted: true, merge_sha: "wrong" }, { owned: false, accepted: true }])
			expect(FactoryAcceptance.safeParse(value).success).toBe(false);
	});
	it.each([{ owned: false } as const, { owned: true, accepted: false } as const])("never touches Linear without accepted production: %j", async (value) => {
		const request = vi.fn<typeof fetch>();
		expect(await new Linear("offline", request).complete("NOR-1436", merge, async () => value)).toBe(false);
		expect(request).not.toHaveBeenCalled();
	});
	it("rejects acceptance for another merge before touching Linear", async () => {
		const request = vi.fn<typeof fetch>();
		await expect(new Linear("offline", request).complete("NOR-1436", merge, async () => ({ owned: true, accepted: true, merge_sha: "b".repeat(40) }))).rejects.toThrow(/another merge/);
		expect(request).not.toHaveBeenCalled();
	});
	it("selects Done even when Merged is the first completed state", async () => {
		const request = vi.fn<typeof fetch>()
			.mockResolvedValueOnce(Response.json({ data: { issue: { id: "issue", team: { states: { nodes: [{ id: "merged", type: "completed", name: "Merged" }, { id: "done", type: "completed", name: "Done" }] } } } } }))
			.mockResolvedValueOnce(Response.json({ data: { issueUpdate: { success: true } } }));
		expect(await new Linear("offline", request).complete("NOR-1436", merge, async () => ({ owned: true, accepted: true, merge_sha: merge }))).toBe(true);
		expect(JSON.parse(String(request.mock.calls[1]?.[1]?.body)).variables).toEqual({ id: "issue", state: "done" });
	});
	it("refuses a team without an exact Done state", async () => {
		const request = vi.fn<typeof fetch>().mockResolvedValueOnce(Response.json({ data: { issue: { id: "issue", team: { states: { nodes: [{ id: "merged", type: "completed", name: "Merged" }] } } } } }));
		await expect(new Linear("offline", request).complete("NOR-1436", merge, async () => ({ owned: true, accepted: true, merge_sha: merge }))).rejects.toThrow(/named Done/);
		expect(request).toHaveBeenCalledTimes(1);
	});
});
