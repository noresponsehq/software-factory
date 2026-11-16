import { expect, it, vi } from "vitest";
import { Ledger, Machines } from "../app/connectors/ledger.js";
import { machineRevisions } from "../app/connectors/production.js";

const build = "a".repeat(40);
const now = Date.parse("2026-11-17T00:00:00Z");
const machine = (app: string, rev = 42) => ({ machine: `${app}-${rev}`, app, build, rev, seen_at: "2026-11-16T23:59:30Z" });
const api = machine("nr-ii-prod-api");
const worker = machine("nr-ii-prod-worker");
it("reads machine revisions with the operator credential and no Fly access", async () => {
	const request = vi.fn<typeof fetch>().mockResolvedValue(Response.json({ machines: [api, worker], rev: 43 }));
	const report = await new Ledger("https://ledger.invalid", "offline-operator", request).machines();
	expect(request).toHaveBeenCalledWith("https://ledger.invalid/ledger/machines", expect.objectContaining({ headers: { Authorization: "Bearer offline-operator" } }));
	expect(machineRevisions(report, build, now)).toEqual({ api: 42, worker: 42 });
});
it("requires the slowest of every recently seen machine", () => {
	expect(machineRevisions({ machines: [api, worker, machine("nr-ii-prod-worker", 39)], rev: 43 }, build, now)).toEqual({ api: 42, worker: 39 });
});
it.each([
	[],
	[{ ...worker, app: "" }],
	[{ ...worker, build: "b".repeat(40) }],
	[{ ...worker, seen_at: "2026-11-16T23:54:59Z" }],
	[{ ...worker, seen_at: "2026-11-17T00:00:01Z" }],
	[worker, { ...worker, machine: "rolling-old", build: "b".repeat(40) }],
].map((workers) => ({ workers })))("refuses missing, stale or wrong-build worker observations %j", ({ workers }) => {
	expect(machineRevisions({ machines: [api, ...workers], rev: 43 }, build, now)).toEqual({ api: 42, worker: null });
});
it("requires both app populations and refuses malformed revisions", () => {
	expect(machineRevisions({ machines: [worker], rev: 43 }, build, now)).toEqual({ api: null, worker: 42 });
	expect(Machines.safeParse({ machines: [{ ...api, rev: -1 }], rev: 43 }).success).toBe(false);
});
