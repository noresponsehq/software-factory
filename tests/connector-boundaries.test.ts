import { describe, expect, it, vi } from "vitest";
import { runClaude } from "../app/connectors/claude.js";
import { readFile } from "node:fs/promises";
import { type Claimed, Ledger } from "../app/connectors/ledger.js";

const state = { cleanup_only: false, version: 1, phase: "review" as const, resource_charges: [], evidence_ids: [] };
const claim = (): Claimed => ({ status: "claimed", run_id: "r1", token: "old", expires_at: "later", state });

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

	it("sends only run and subscription credentials to the guest and never in command arguments", async () => {
		const sandbox = {
			id: "s1",
			upload: vi.fn(async (_path: string, _contents: string | Uint8Array) => {}),
			download: vi.fn(),
			close: vi.fn(),
			exec: vi.fn(async (command: string) => ({
				exitCode: 0,
				stdout: command.includes(" node ")
					? JSON.stringify({ is_error: false, structured_output: { status: "implemented", summary: "done", evidence: [] } })
					: command.startsWith("claude --version")
						? "2.1.0"
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
			model: "claude-opus-5-5",
		});
		expect(JSON.stringify(sandbox.exec.mock.calls)).not.toContain("secret");
		const input = sandbox.upload.mock.calls.find(([path]) => path.endsWith("/input.json"))?.[1];
		expect(JSON.parse(String(input)).schema).toMatchObject({
			$schema: "http://json-schema.org/draft-07/schema#",
			additionalProperties: false,
			properties: {
				summary: { minLength: 1, maxLength: 10000 },
				evidence: { maxItems: 100, items: { minLength: 1, maxLength: 500 } },
				addressed_threads: { maxItems: 100, items: { minLength: 1, maxLength: 256 } },
			},
		});
		expect(sandbox.exec.mock.calls.at(-1)?.[0]).toMatch(/^rm -rf/);
	});
	it("keeps known cleanup and charge state when a ledger response omits it", async () => {
		const charge = { key: "render-1", kind: "render_sandbox", reserved_usd: 1, status: "started" as const, resource_id: "s1" };
		const known = { ...state, cleanup_only: true, resource_charges: [charge], evidence_ids: ["ev1"] };
		const narrow = { version: 2, phase: "review" };
		const request = vi
			.fn<typeof fetch>()
			.mockResolvedValueOnce(Response.json({ ...claim(), state: narrow }))
			.mockResolvedValueOnce(Response.json({ evidence_id: "ev2", state: { ...narrow, version: 2 } }));
		const ledger = new Ledger("https://ledger.test", "operator", request);
		const active = { ...claim(), state: known };
		await ledger.heartbeat(active, 100);
		expect(active.state).toMatchObject({ version: 2, cleanup_only: true, resource_charges: [charge], evidence_ids: ["ev1"] });
		await ledger.evidence(active, "a".repeat(40), "verification", { status: "pass" });
		expect(active.state).toMatchObject({ cleanup_only: true, resource_charges: [charge], evidence_ids: ["ev1"] });
	});
	it("takes a reported empty state as the new truth", async () => {
		const charge = { key: "render-1", kind: "render_sandbox", reserved_usd: 1, status: "terminated" as const, resource_id: "s1" };
		const request = vi
			.fn<typeof fetch>()
			.mockResolvedValue(Response.json({ ...claim(), state: { ...state, version: 2, cleanup_only: false, resource_charges: [], evidence_ids: [] } }));
		const active = { ...claim(), state: { ...state, cleanup_only: true, resource_charges: [charge], evidence_ids: ["ev1"] } };
		await new Ledger("https://ledger.test", "operator", request).heartbeat(active, 100);
		expect(active.state).toMatchObject({ cleanup_only: false, resource_charges: [], evidence_ids: [] });
	});
	it("refuses a claim whose state omits cleanup or charges, since nothing is known yet", async () => {
		const request = vi
			.fn<typeof fetch>()
			.mockResolvedValue(
				Response.json(
					{ status: "claimed", run_id: "r1", token: "t", expires_at: "later", state: { version: 0, phase: "research" } },
					{ status: 201 },
				),
			);
		const ledger = new Ledger("https://ledger.test", "operator", request);
		const claiming = ledger.claim({
			event_id: "e",
			connector: "github",
			linear_issue: "NOR-1",
			condition_hash: "h",
			reserve_usd: 8,
			tool_allowance_usd: 0,
			lease_seconds: 60,
		});
		await expect(claiming).rejects.toThrow();
	});
	it("launches subscription Claude with an explicit model and records the harness identity", async () => {
		const uploads: [string, string][] = [];
		const sandbox = {
			id: "s1",
			upload: vi.fn(async (path: string, data: string | Buffer) => {
				uploads.push([path, String(data)]);
			}),
			download: vi.fn(),
			close: vi.fn(),
			exec: vi.fn(async (command: string) => ({
				exitCode: 0,
				stdout: command.includes(" node ")
					? JSON.stringify({ is_error: false, structured_output: { status: "verified", summary: "done", evidence: ["e"] } })
					: command.startsWith("claude --version")
						? "2.1.0 (Claude Code)\n"
						: command.startsWith("sha256sum")
							? `${"d".repeat(64)}  .agents/skills/a/SKILL.md\n`
							: "",
				stderr: "",
			})),
		};
		const base = { prompt: "work", subscriptionToken: "s", runToken: "r", ledgerUrl: "https://ledger.test", seconds: 30 };
		await expect(runClaude(sandbox, { ...base, model: "" })).rejects.toThrow(/explicit model/);
		const run = await runClaude(sandbox, { ...base, model: "claude-opus-5-5" });
		expect(JSON.parse(uploads.find(([path]) => path.endsWith("input.json"))?.[1] ?? "{}").model).toBe("claude-opus-5-5");
		expect(run.harness).toMatchObject({ harness: "claude_code", model: "claude-opus-5-5", cli_version: "2.1.0 (Claude Code)", skills: 1 });
		expect(run.result.negative_control).toBeNull();
		const launcher = await readFile(new URL("../sandbox/claude-launch.mjs", import.meta.url), "utf8");
		expect(launcher).toMatch(/"--model", input\.model/);
	});
});
