import { describe, expect, it, vi } from "vitest";
import { bundleRefusal, EvidenceRefused, uploadArtifacts, type VerificationBundle } from "../app/connectors/bundle.js";
import { base, candidateBundle, head } from "./helpers/bundle.js";
import { pairedNegativeControl } from "../app/connectors/negative-control.js";
import type { Sandbox } from "../app/sandbox/index.js";

describe("host refusal of a verification bundle", () => {
	it("accepts a complete candidate bundle", () => {
		expect(bundleRefusal(candidateBundle(), { stage: "candidate", sha: head })).toBeNull();
	});
	const cases: [string, (b: VerificationBundle) => unknown, RegExp][] = [
		["a missing bundle", () => null, /missing/],
		["an agent summary in place of a bundle", () => ({ summary: "verified", evidence: ["ok"] }), /missing/],
		["a bundle without a task digest", ({ task_sha256: _, ...rest }) => rest, /missing/],
		["a bundle for another revision", (b) => ({ ...b, candidate_sha: base }), /another revision/],
		["a typed failure", (b) => ({ ...b, outcome: "failed", failure_class: "stale_control" }), /failure/],
		["no assertions", (b) => ({ ...b, assertions: [] }), /assertions/],
		["a failed assertion", (b) => ({ ...b, assertions: [{ ...b.assertions[0], passed: false }] }), /assertions/],
		["no uploaded artifacts", (b) => ({ ...b, artifacts: [] }), /artifacts/],
		["an artifact without a digest", (b) => ({ ...b, artifacts: [{ ...b.artifacts[0], sha256: "x" }] }), /missing/],
		["no negative control", (b) => ({ ...b, negative_control: null }), /negative control/],
		[
			"a control that passed unfixed code",
			(b) => ({ ...b, negative_control: { ...b.negative_control, unfixed: { sha: base, exit_code: 0 } } }),
			/unfixed/,
		],
		[
			"a control that did not run unfixed",
			(b) => ({ ...b, negative_control: { ...b.negative_control, unfixed: { sha: base, exit_code: null } } }),
			/unfixed/,
		],
		[
			"a control that failed the candidate",
			(b) => ({ ...b, negative_control: { ...b.negative_control, candidate: { sha: head, exit_code: 1 } } }),
			/candidate/,
		],
		[
			"a control on another base",
			(b) => ({ ...b, negative_control: { ...b.negative_control, unfixed: { sha: head, exit_code: 1 } } }),
			/other revisions/,
		],
		["no model and harness identity", (b) => ({ ...b, harness: null }), /harness/],
	];
	it.each(cases)("refuses %s", (_, mutate, reason) => {
		expect(bundleRefusal(mutate(candidateBundle()), { stage: "candidate", sha: head })).toMatch(reason);
	});
	it("refuses production proof that observed another release", () => {
		const production = { ...candidateBundle(), stage: "production" as const, negative_control: null, harness: null, observed_release_sha: base };
		expect(bundleRefusal(production, { stage: "production", sha: head })).toMatch(/another release/);
		expect(bundleRefusal({ ...production, observed_release_sha: head }, { stage: "production", sha: head })).toBeNull();
	});
});

describe("artifact upload", () => {
	it("stores each text artifact as content-addressed chunks and lists refused or binary ones as uncovered", async () => {
		const store = vi.fn(async (payload: Record<string, unknown>) => {
			if (payload.artifact === "refused.log") throw new EvidenceRefused("sensitive");
			return `ev-${store.mock.calls.length}`;
		});
		const result = await uploadArtifacts(
			[
				{ name: "big.json", content: Buffer.from("x".repeat(25000)) },
				{ name: "refused.log", content: Buffer.from("token") },
				{ name: "shot.png", content: Buffer.from([0xff, 0xfe, 0x00]) },
			],
			store,
		);
		expect(result.artifacts).toEqual([expect.objectContaining({ name: "big.json", bytes: 25000, evidence_ids: ["ev-1", "ev-2", "ev-3"] })]);
		expect(store.mock.calls.slice(0, 3).map(([p]) => (p.content as string).length)).toEqual([12000, 12000, 1000]);
		expect(result.uncovered).toEqual([expect.stringMatching(/refused.log .* refused/), expect.stringMatching(/shot.png .* binary/)]);
	});
	it("does not hide a ledger outage as an uncovered artifact", async () => {
		await expect(
			uploadArtifacts([{ name: "a", content: Buffer.from("a") }], async () => {
				throw new Error("Factory ledger evidence returned 503");
			}),
		).rejects.toThrow(/503/);
	});
});

describe("paired negative control", () => {
	const fakeSandbox = (exitCode: number) => {
		const files = new Map<string, Buffer>();
		return {
			files,
			sandbox: {
				id: "s",
				exec: vi.fn(async (command: string) => ({ exitCode: command.startsWith("mkdir") ? 0 : exitCode, stdout: `ran ${exitCode}`, stderr: "" })),
				upload: vi.fn(async (path: string, data: string | Buffer) => {
					files.set(path, Buffer.from(data));
				}),
				download: vi.fn(async () => Buffer.from("package github")),
				close: vi.fn(),
			} satisfies Sandbox,
		};
	};
	it("runs the candidate's tests on the unfixed base and on the candidate with the same fixture", async () => {
		const unfixed = fakeSandbox(1);
		const candidate = fakeSandbox(0);
		const result = await pairedNegativeControl(
			{ test_paths: ["apps/identity/internal/connectors/github/github_test.go"], run: "TestMissing" },
			"github",
			{ sandbox: unfixed.sandbox, sha: base },
			{ sandbox: candidate.sandbox, sha: head },
		);
		expect(unfixed.files.get("/opt/factory/repo/apps/identity/internal/connectors/github/github_test.go")?.toString()).toBe("package github");
		expect(result).toMatchObject({ control: { unfixed: { sha: base, exit_code: 1 }, candidate: { sha: head, exit_code: 0 } } });
		const bundle = candidateBundle();
		if (!("control" in result)) throw new Error("expected a control");
		bundle.negative_control = result.control;
		expect(bundleRefusal(bundle, { stage: "candidate", sha: head })).toBeNull();
	});
	it.each([
		["apps/identity/internal/connector/known_test.go"],
		["apps/identity/internal/connectors/github/../x_test.go"],
		["apps/identity/internal/connectors/github/github.go"],
	])("refuses test path %s outside the connector's tests", async (path) => {
		const unfixed = fakeSandbox(1);
		expect(
			await pairedNegativeControl(
				{ test_paths: [path], run: "TestX" },
				"github",
				{ sandbox: unfixed.sandbox, sha: base },
				{ sandbox: fakeSandbox(0).sandbox, sha: head },
			),
		).toEqual({ refused: expect.stringMatching(/connector folder/) });
		expect(unfixed.sandbox.upload).not.toHaveBeenCalled();
	});
	it("refuses a verifier that names no negative control", async () => {
		expect(
			await pairedNegativeControl(null, "github", { sandbox: fakeSandbox(1).sandbox, sha: base }, { sandbox: fakeSandbox(0).sandbox, sha: head }),
		).toEqual({
			refused: "verifier supplied no negative control",
		});
	});
});
