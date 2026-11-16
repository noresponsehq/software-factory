import { describe, expect, it, vi } from "vitest";
import { runClaude } from "../app/connectors/claude.js";
import { type Claimed, Ledger } from "../app/connectors/ledger.js";
import { parseProbe } from "../app/connectors/probe.js";

const state = { version: 1, phase: "review" as const, resource_charges: [], evidence_ids: [] };
const claim = (): Claimed => ({ status: "claimed", run_id: "r1", token: "old", expires_at: "later", state });
const proof = { connector: "github", control: { verdict: "passed" }, admission: { passes: true }, tests: { pass: 4, fail: 0, skip: 0, exit: 0 } };
describe("factory trust boundaries", () => {
	it("keeps rotated lease tokens and updates the CAS version", async () => {
		const request = vi.fn<typeof fetch>().mockResolvedValue(Response.json({ ...claim(), token: "rotated", state: { ...state, version: 2 } }));
		const ledger = new Ledger("https://ledger.test", "operator", request);
		const active = claim();
		await ledger.heartbeat(active, 100);
		expect(active.token).toBe("rotated");
		expect(active.state.version).toBe(2);
		const init = request.mock.calls[0]?.[1];
		expect(init?.redirect).toBe("error");
		expect(JSON.parse(init?.body as string)).toMatchObject({ token: "old", expected_version: 1 });
	});
	it("does not leak provider error bodies or credentials", async () => {
		const ledger = new Ledger(
			"https://ledger.test",
			"operator",
			vi.fn<typeof fetch>().mockResolvedValue(new Response("secret provider payload", { status: 409 })),
		);
		await expect(ledger.heartbeat(claim(), 100)).rejects.toThrow("Factory ledger heartbeat returned 409");
	});
	it("accepts only matching successful probe controls, admission and nonempty tests", () => {
		expect(parseProbe(`${JSON.stringify(proof)}\nNRPROBE_STATUS 0`, "github").tests.pass).toBe(4);
		for (const bad of [
			{},
			{ ...proof, connector: "other" },
			{ ...proof, control: { verdict: "failed" } },
			{ ...proof, admission: { passes: false } },
			{ ...proof, tests: { pass: 0, fail: 0, skip: 0, exit: 0 } },
		])
			expect(() => parseProbe(`${JSON.stringify(bad)}\nNRPROBE_STATUS 0`, "github")).toThrow();
		expect(() => parseProbe(JSON.stringify(proof), "github")).toThrow();
		expect(() => parseProbe(`${JSON.stringify(proof)}\nNRPROBE_STATUS 1`, "github")).toThrow();
	});
	it("sends only run and subscription credentials to the guest and never in command arguments", async () => {
		const sandbox = {
			id: "s1",
			upload: vi.fn(async () => {}),
			download: vi.fn(),
			close: vi.fn(),
			exec: vi.fn(async (command: string) => ({
				exitCode: 0,
				stdout: command.startsWith("node ")
					? JSON.stringify({ is_error: false, structured_output: { status: "implemented", summary: "done", evidence: [] } })
					: "",
				stderr: "",
			})),
		};
		await runClaude(sandbox, {
			prompt: "work",
			subscriptionToken: "subscription-secret",
			runToken: "run-secret",
			ledgerUrl: "https://ledger.test",
			seconds: 30,
		});
		expect(JSON.stringify(sandbox.exec.mock.calls)).not.toContain("secret");
		expect(sandbox.exec.mock.calls.at(-1)?.[0]).toMatch(/^rm -rf/);
	});
});
