import type { VerificationBundle } from "../../app/connectors/bundle.js";

export const head = "a".repeat(40);
export const base = "b".repeat(40);
const digest = "c".repeat(64);
export function candidateBundle(): VerificationBundle {
	return {
		version: 1,
		stage: "candidate",
		outcome: "verified",
		failure_class: null,
		task_sha256: digest,
		acceptance_recipe_sha256: digest,
		candidate_sha: head,
		trusted_base_sha: base,
		observed_release_sha: null,
		fixtures: [{ name: "trusted connector control", sha256: digest }],
		session_generations: [],
		selection: "go test ./internal/connectors/github/",
		reproduction: [`git checkout ${head} && go test ./internal/connectors/github/`],
		assertions: [{ name: "focused tests", expected: "exit 0", observed: "exit 0", passed: true }],
		negative_control: {
			command: "cd apps/identity && go test -count=1 -run 'TestMissing' ./internal/connectors/github/",
			fixture_sha256: digest,
			tests: ["github/TestMissing"],
			unfixed: { sha: base, exit_code: 1 },
			candidate: { sha: head, exit_code: 0 },
		},
		artifacts: [{ name: "verifier/output.json", sha256: digest, bytes: 10, evidence_ids: ["ev1"] }],
		harness: {
			harness: "claude_code",
			model: "claude-opus-5-5",
			cli_version: "2.1.0 (Claude Code)",
			launcher_sha256: digest,
			prompt_sha256: digest,
			skills_sha256: digest,
			skills: 4,
		},
		uncovered: [],
	};
}
