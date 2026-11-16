import type { AcceptanceRun, Case, CaseResult, Observation, Score, Totals } from "./schema.js";

export function scoreCase(c: Case, observation: Observation, acceptance: AcceptanceRun): Score {
	if (observation.verdict === "environment_failure") return "environment_failure";
	if (observation.verdict === "complete") {
		if (c.expected.outcome !== "complete") return "incorrect_acceptance";
		if (acceptance.status === "not_run") return "environment_failure";
		return acceptance.status === "passed" ? "correct_completion" : "incorrect_acceptance";
	}
	if (c.expected.outcome === "complete") return "incorrect_block";
	return observation.reason === c.expected.reason ? "correct_block" : "wrong_block_reason";
}

export function totals(results: CaseResult[]): Totals {
	const count = (score: Score) => results.filter((r) => r.score === score).length;
	const environment = count("environment_failure");
	const correct = count("correct_completion") + count("correct_block");
	const judged = results.length - environment;
	return {
		cases: results.length,
		correct_completion: count("correct_completion"),
		correct_block: count("correct_block"),
		incorrect_acceptance: count("incorrect_acceptance"),
		incorrect_block: count("incorrect_block"),
		wrong_block_reason: count("wrong_block_reason"),
		environment_failure: environment,
		human_interventions: results.reduce((sum, r) => sum + r.observation.human_interventions, 0),
		cost_usd: Math.round(results.reduce((sum, r) => sum + r.observation.cost_usd, 0) * 1e6) / 1e6,
		reliability: judged === 0 ? null : correct / judged,
	};
}
