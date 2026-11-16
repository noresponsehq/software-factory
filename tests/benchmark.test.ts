import { describe, expect, it } from "vitest";
import { alwaysAccept, loadCorpus, oracle, runCase, select } from "../scripts/benchmark/run.js";
import { Corpus } from "../scripts/benchmark/schema.js";
import { totals } from "../scripts/benchmark/score.js";

const { corpus } = loadCorpus();
const byId = (id: string) => {
	const found = corpus.cases.find((c) => c.id === id);
	if (!found) throw new Error(id);
	return found;
};
const passed = async () => ({ status: "passed" as const, exit_code: 0 });
const failed = async () => ({ status: "failed" as const, exit_code: 1 });
const notRun = async () => ({ status: "not_run" as const, exit_code: null });

describe("benchmark corpus", () => {
	it("covers every category with ten cases", () => {
		expect(corpus.cases).toHaveLength(10);
		expect(new Set(corpus.cases.map((c) => c.category)).size).toBe(10);
	});

	it("refuses a synthetic case without a fixture and a completing case without a trusted check", () => {
		const synthetic = { ...byId("stale_positive_control"), fixture: undefined };
		const unchecked = { ...byId("outage_read_as_absence"), acceptance: undefined };
		expect(Corpus.safeParse({ ...corpus, cases: [synthetic] }).success).toBe(false);
		expect(Corpus.safeParse({ ...corpus, cases: [unchecked] }).success).toBe(false);
	});

	it("rejects an unknown selection", () => {
		expect(() => select(corpus, ["no_such_case"])).toThrow(/unknown case ids/);
	});
});

describe("benchmark scorer", () => {
	it("counts a completion whose trusted check fails as a false acceptance", async () => {
		const result = await runCase(byId("outage_read_as_absence"), async (c) => alwaysAccept(c), failed);
		expect(result.score).toBe("incorrect_acceptance");
		expect(totals([result]).reliability).toBe(0);
	});

	it("counts completing a case that must be blocked as a false acceptance even when tests pass", async () => {
		const result = await runCase(byId("smoke_without_connector"), async (c) => alwaysAccept(c), passed);
		expect(result.score).toBe("incorrect_acceptance");
		expect(result.acceptance.status).toBe("not_run");
	});

	it("counts a completion without a candidate commit as a false acceptance", async () => {
		const c = byId("dotted_cookie_slot");
		const result = await runCase(c, async () => ({ verdict: "complete", cost_usd: 1, human_interventions: 0, duration_seconds: 1 }), passed);
		expect(result.score).toBe("incorrect_acceptance");
	});

	it("scores the expected outcomes as fully reliable", async () => {
		const results = await Promise.all(corpus.cases.map((c) => runCase(c, async () => oracle(c), passed)));
		expect(totals(results)).toMatchObject({ correct_completion: 6, correct_block: 4, incorrect_acceptance: 0, reliability: 1 });
	});

	it("needs the expected reason for a correct block", async () => {
		const c = byId("proof_without_artifacts");
		const result = await runCase(
			c,
			async () => ({ verdict: "refused", reason: "stale_control", cost_usd: 0, human_interventions: 0, duration_seconds: 0 }),
			passed,
		);
		expect(result.score).toBe("wrong_block_reason");
	});

	it("counts a refused completable task as an incorrect block", async () => {
		const c = byId("ambiguous_retry");
		const result = await runCase(
			c,
			async () => ({ verdict: "blocked", reason: "x", cost_usd: 0, human_interventions: 1, duration_seconds: 0 }),
			passed,
		);
		expect(result.score).toBe("incorrect_block");
	});

	it("separates environment failures from verdicts and leaves them out of reliability", async () => {
		const crashed = await runCase(byId("release_superseded"), async () => Promise.reject(new Error("sandbox lost")), passed);
		const unchecked = await runCase(byId("ambiguous_retry"), async (c) => alwaysAccept(c), notRun);
		const right = await runCase(byId("name_only_match"), async (c) => oracle(c), passed);
		expect([crashed.score, unchecked.score]).toEqual(["environment_failure", "environment_failure"]);
		expect(totals([crashed, unchecked, right])).toMatchObject({ environment_failure: 2, reliability: 1 });
	});

	it("sums cost and human intervention", async () => {
		const c = byId("http_200_captcha_page");
		const observation = { verdict: "complete" as const, candidate_commit: c.base_commit, cost_usd: 2.5, human_interventions: 2, duration_seconds: 9 };
		const results = await Promise.all([runCase(c, async () => observation, passed), runCase(c, async () => observation, passed)]);
		expect(totals(results)).toMatchObject({ cost_usd: 5, human_interventions: 4 });
	});
});
