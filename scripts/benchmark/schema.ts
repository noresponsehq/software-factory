import { z } from "zod";

const Sha = z.string().regex(/^[0-9a-f]{40}$/);
const Text = (max: number) => z.string().min(1).max(max);

export const Outcome = z.enum(["complete", "blocked", "refused", "rejected"]);
export type Outcome = z.infer<typeof Outcome>;

export const Reason = z.enum(["stale_control", "missing_artifacts", "false_flag_increase", "connector_not_exercised"]);

export const Category = z.enum([
	"outage_as_absence",
	"dropped_investigator_field",
	"http_200_challenge",
	"stale_positive_control",
	"shared_parser_repair",
	"superseded_release",
	"ambiguous_external_effect",
	"missing_proof_artifacts",
	"false_flag_increase",
	"connector_not_exercised",
]);

const Acceptance = z.strictObject({
	cwd: Text(200),
	command: Text(500),
	trusted_files: z.array(Text(300)).max(20),
	requires: z.array(z.enum(["go", "python3", "postgres", "node"])).max(5),
});

const Source = z.discriminatedUnion("kind", [
	z.strictObject({ kind: z.literal("historical"), fix_commit: Sha, note: Text(500) }),
	z.strictObject({ kind: z.literal("inverted"), fix_commit: Sha, note: Text(500) }),
	z.strictObject({ kind: z.literal("synthetic"), note: Text(500) }),
]);

export const Case = z
	.strictObject({
		id: z.string().regex(/^[a-z0-9_]{3,64}$/),
		category: Category,
		title: Text(200),
		source: Source,
		base_commit: Sha,
		task: Text(4000),
		fixture: z.record(z.string().max(64), z.union([z.string().max(500), z.number()])).optional(),
		expected: z.discriminatedUnion("outcome", [
			z.strictObject({ outcome: z.literal("complete") }),
			z.strictObject({ outcome: z.enum(["blocked", "refused", "rejected"]), reason: Reason }),
		]),
		acceptance: Acceptance.optional(),
	})
	.superRefine((c, ctx) => {
		if (c.expected.outcome === "complete" && !c.acceptance)
			ctx.addIssue({ code: "custom", message: "a case expected to complete needs a trusted acceptance check" });
		if (c.source.kind === "synthetic" && !c.fixture) ctx.addIssue({ code: "custom", message: "a synthetic case needs a fixture" });
		if (c.source.kind === "historical" && c.expected.outcome !== "complete")
			ctx.addIssue({ code: "custom", message: "a historical case replays a fix, so it is expected to complete" });
	});
export type Case = z.infer<typeof Case>;

export const Corpus = z
	.strictObject({ version: z.literal(1), repository: Text(200), cases: z.array(Case).min(1).max(100) })
	.superRefine((corpus, ctx) => {
		const seen = new Set<string>();
		for (const c of corpus.cases) {
			if (seen.has(c.id)) ctx.addIssue({ code: "custom", message: `duplicate case id ${c.id}` });
			seen.add(c.id);
		}
	});
export type Corpus = z.infer<typeof Corpus>;

export const Observation = z.strictObject({
	verdict: z.enum(["complete", "blocked", "refused", "rejected", "environment_failure"]),
	reason: z.string().max(200).optional(),
	candidate_commit: Sha.optional(),
	cost_usd: z.number().nonnegative().max(1000),
	human_interventions: z.number().int().nonnegative().max(1000),
	duration_seconds: z.number().nonnegative().max(86400),
	detail: z.string().max(2000).optional(),
});
export type Observation = z.infer<typeof Observation>;

export const Score = z.enum([
	"correct_completion",
	"correct_block",
	"incorrect_acceptance",
	"incorrect_block",
	"wrong_block_reason",
	"environment_failure",
]);
export type Score = z.infer<typeof Score>;

export const AcceptanceRun = z.strictObject({
	status: z.enum(["passed", "failed", "not_run"]),
	exit_code: z.number().int().nullable(),
	detail: z.string().max(2000).optional(),
});
export type AcceptanceRun = z.infer<typeof AcceptanceRun>;

export const CaseResult = z.strictObject({
	id: z.string(),
	category: Category,
	expected: Outcome,
	observation: Observation,
	acceptance: AcceptanceRun,
	score: Score,
});
export type CaseResult = z.infer<typeof CaseResult>;

export const Totals = z.strictObject({
	cases: z.number().int(),
	correct_completion: z.number().int(),
	correct_block: z.number().int(),
	incorrect_acceptance: z.number().int(),
	incorrect_block: z.number().int(),
	wrong_block_reason: z.number().int(),
	environment_failure: z.number().int(),
	human_interventions: z.number().int(),
	cost_usd: z.number(),
	reliability: z.number().nullable(),
});
export type Totals = z.infer<typeof Totals>;

export const RunResult = z.strictObject({
	schema_version: z.literal(1),
	mode: z.enum(["dry", "live"]),
	started_at: z.string(),
	finished_at: z.string(),
	corpus_sha256: z.string().regex(/^[0-9a-f]{64}$/),
	identity: z.strictObject({
		model: Text(200),
		harness: Text(200),
		harness_version: Text(200),
		factory_commit: Text(64),
		executor: Text(500),
	}),
	selection: z.array(z.string()).min(1),
	cases: z.array(CaseResult),
	totals: Totals,
});
export type RunResult = z.infer<typeof RunResult>;
