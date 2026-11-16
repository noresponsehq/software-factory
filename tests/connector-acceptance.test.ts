import { describe, expect, it, vi } from "vitest";
import { type AcceptanceRecipe, type ProofPorts, proveRelease } from "../app/connectors/acceptance.js";
import { released } from "../app/connectors/release.js";
import type { GitHubHttp } from "../app/github/index.js";

const A = "a".repeat(40);
const B = "b".repeat(40);
const OLD = "0".repeat(40);
const recipe: AcceptanceRecipe = {
	connector: "github",
	behaviour: "reads the account's display name and join date by username",
	fixtures: [{ ref: "control.present", identifier: "username", platform: "github", value: "octocat" }],
	requires: { session: false, route: "api.github.com/users/{handle}" },
	operation: { kind: "group_person_lookup", fixture: "control.present" },
	expect: { execution: "found", fields: ["name", "created_at"] },
	observe: { ledger_revision: 42 },
	uncovered: ["a rate-limited answer"],
};
const lookup = (connector: string, fields: string[], unanswered: { connector: string; reason: string }[] = []) => ({
	checks: [{ identifier: "username", status: "found", answered: 3, unanswered }],
	records: [{ source: { connector }, fields: fields.map((field) => ({ field })) }],
});
function ports(overrides: Partial<ProofPorts> = {}) {
	let now = 0;
	const smoke = vi.fn(async () => ({
		operator_sha: "c".repeat(40),
		selection: "version,search",
		exit_code: 0,
		status: "pass",
		checks: 2,
		failed: 0,
		skipped: 0,
	}));
	return {
		version: vi.fn(async () => A),
		contains: vi.fn(async (older: string, newer: string) => older === A && newer === B),
		revisions: vi.fn(async () => ({ api: 42, worker: 42 })),
		smoke,
		lookup: vi.fn(async () => lookup("github", ["name", "created_at", "bio"])),
		clock: {
			now: () => now,
			sleep: async (ms: number) => {
				now += ms;
			},
			timeoutMs: 30000,
			intervalMs: 5000,
		},
		...overrides,
	} satisfies ProofPorts;
}
const failure = (reason: string) => expect.objectContaining({ kind: "production", payload: expect.objectContaining({ status: "fail", reason }) });

describe("production acceptance", () => {
	it("passes only when the named connector produced the expected public fields at the required ledger revision", async () => {
		const p = ports();
		expect(await proveRelease(A, recipe, p)).toMatchObject({
			release_state: "exact",
			requested: A,
			observed: A,
			ledger_revision: { required: 42, api: 42, worker: 42 },
			behaviour: { connector: "github", execution: "found", fields: ["name", "created_at"] },
			status: "pass",
		});
	});
	it("fails when the shared smoke passes but the named connector did not run", async () => {
		const p = ports({ lookup: vi.fn(async () => lookup("gitlab", ["name", "created_at"])) });
		await expect(proveRelease(A, recipe, p)).rejects.toEqual(failure("connector_not_executed"));
		expect(p.smoke).toHaveBeenCalled();
	});
	it("fails when the connector did not answer instead of reading it as not found", async () => {
		const p = ports({ lookup: vi.fn(async () => lookup("gitlab", [], [{ connector: "github", reason: "timeout" }])) });
		await expect(proveRelease(A, recipe, p)).rejects.toEqual(failure("connector_unanswered"));
	});
	it("polls followers and fails typed when the worker never reports the required ledger revision", async () => {
		const p = ports({ revisions: vi.fn(async () => ({ api: 42, worker: 41 })) });
		await expect(proveRelease(A, recipe, p)).rejects.toEqual(
			expect.objectContaining({ payload: expect.objectContaining({ reason: "ledger_revision_not_observed", required: 42, api: 42, worker: 41 }) }),
		);
		expect(vi.mocked(p.revisions).mock.calls.length).toBeGreaterThan(1);
		expect(p.lookup).not.toHaveBeenCalled();
	});
	it("records a superseded release and passes only with fresh proof against the observed build", async () => {
		const p = ports({ version: vi.fn(async () => B) });
		expect(await proveRelease(A, recipe, p)).toMatchObject({ sha: A, release_state: "superseded", requested: A, observed: B });
		expect(p.smoke).toHaveBeenCalledWith(B);
		expect(p.lookup).toHaveBeenCalledTimes(1);
	});
	it("fails a superseded release when the later build breaks the behaviour", async () => {
		const p = ports({ version: vi.fn(async () => B), lookup: vi.fn(async () => lookup("github", ["name"])) });
		await expect(proveRelease(A, recipe, p)).rejects.toEqual(failure("fields_missing"));
	});
	it("re-runs the behavioural proof when production moves from A to B during verification", async () => {
		const version = vi.fn().mockResolvedValueOnce(A).mockResolvedValueOnce(B).mockResolvedValue(B);
		const p = ports({ version });
		expect(await proveRelease(A, recipe, p)).toMatchObject({ release_state: "superseded", observed: B });
		expect(p.lookup).toHaveBeenCalledTimes(2);
		expect(vi.mocked(p.smoke).mock.calls).toEqual([[A], [B]]);
	});
	it("refuses a production build older than the requested merge", async () => {
		const p = ports({ version: vi.fn(async () => OLD) });
		await expect(proveRelease(A, recipe, p)).rejects.toEqual(failure("stale_build"));
		expect(p.smoke).not.toHaveBeenCalled();
	});
});

describe("release states", () => {
	it("does not call a deploy skipped because a later release contains it failed", async () => {
		const runs = {
			workflow_runs: [
				{ id: 2, status: "completed", conclusion: "success", html_url: "https://b" },
				{ id: 1, status: "completed", conclusion: "cancelled", html_url: "https://a" },
			],
		};
		const jobs: Record<number, unknown> = {
			2: {
				jobs: [
					{ id: 20, name: "plan", status: "completed", conclusion: "success" },
					{ id: 21, name: "release", status: "completed", conclusion: "success" },
				],
			},
			1: {
				jobs: [
					{ id: 10, name: "plan", status: "completed", conclusion: "success" },
					{ id: 11, name: "release", status: "completed", conclusion: "skipped" },
				],
			},
		};
		const logs: Record<string, string> = {
			"20": `running: ${OLD}; candidate: ${B}; release: true`,
			"10": `running: ${OLD}; candidate: ${A}; release: true`,
		};
		const http = {
			json: vi.fn(async (_method: string, path: string) => {
				if (path.endsWith("/runs")) return runs;
				if (path.includes("/compare/")) return { status: path.endsWith(`${A}...${B}`) ? "ahead" : "behind" };
				return jobs[Number(/runs\/(\d+)\/jobs/.exec(path)?.[1])];
			}),
			text: vi.fn(async (_method: string, path: string) => logs[/jobs\/(\d+)\/logs/.exec(path)?.[1] ?? ""] ?? ""),
		} as unknown as GitHubHttp;
		expect(await released(http, "o/r", A)).toEqual({ status: "superseded", url: "https://b", requested: A, observed: B });
	});
});
