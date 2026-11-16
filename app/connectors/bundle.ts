import { createHash } from "node:crypto";
import { z } from "zod";

export const FailureClass = z.enum(["missing_prerequisite", "product_failure", "stale_control", "superseded_release", "environment_failure"]);
export type FailureClass = z.infer<typeof FailureClass>;

const Sha = z.string().regex(/^[a-f0-9]{40}$/);
const Digest = z.string().regex(/^[a-f0-9]{64}$/);
const Text = z.string().min(1).max(500);

export const ArtifactRef = z.strictObject({
	name: z.string().min(1).max(200),
	sha256: Digest,
	bytes: z.number().int().nonnegative(),
	evidence_ids: z.array(z.string().min(1).max(200)).min(1).max(64),
});
export type ArtifactRef = z.infer<typeof ArtifactRef>;

export const Assertion = z.strictObject({ name: Text, expected: Text, observed: Text, passed: z.boolean() });
export type Assertion = z.infer<typeof Assertion>;

export const NegativeControl = z.strictObject({
	command: z.string().min(1).max(1000),
	fixture_sha256: Digest,
	tests: z.array(z.string().min(1).max(500)).min(1).max(200),
	unfixed: z.strictObject({ sha: Sha, exit_code: z.number().int().nullable() }),
	candidate: z.strictObject({ sha: Sha, exit_code: z.number().int().nullable() }),
});
export type NegativeControl = z.infer<typeof NegativeControl>;

export const HarnessIdentity = z.strictObject({
	harness: z.literal("claude_code"),
	model: z.string().min(1).max(100),
	cli_version: z.string().min(1).max(100),
	launcher_sha256: Digest,
	prompt_sha256: Digest,
	skills_sha256: Digest,
	skills: z.number().int().nonnegative(),
});
export type HarnessIdentity = z.infer<typeof HarnessIdentity>;

export const VerificationBundle = z.strictObject({
	version: z.literal(1),
	stage: z.enum(["candidate", "production"]),
	outcome: z.enum(["verified", "failed"]),
	failure_class: FailureClass.nullable(),
	task_sha256: Digest,
	acceptance_recipe_sha256: Digest,
	candidate_sha: Sha,
	trusted_base_sha: Sha,
	observed_release_sha: Sha.nullable(),
	fixtures: z.array(z.strictObject({ name: Text, sha256: Digest })).max(50),
	session_generations: z.array(z.strictObject({ name: Text, sha256: Digest })).max(50),
	selection: z.string().min(1).max(1000),
	reproduction: z.array(z.string().min(1).max(1000)).min(1).max(20),
	assertions: z.array(Assertion).max(60),
	negative_control: NegativeControl.nullable(),
	artifacts: z.array(ArtifactRef).max(60),
	harness: HarnessIdentity.nullable(),
	uncovered: z.array(Text).max(50),
});
export type VerificationBundle = z.infer<typeof VerificationBundle>;

export const sha256 = (data: string | Buffer) => createHash("sha256").update(data).digest("hex");

export function bundleRefusal(raw: unknown, expected: { stage: VerificationBundle["stage"]; sha: string }): string | null {
	const parsed = VerificationBundle.safeParse(raw);
	if (!parsed.success) return "verification bundle is missing or malformed";
	const bundle = parsed.data;
	if (bundle.stage !== expected.stage) return "verification bundle is for another stage";
	if (bundle.candidate_sha !== expected.sha) return "verification bundle names another revision";
	if (bundle.outcome !== "verified" || bundle.failure_class !== null) return "verification bundle records a failure";
	if (!bundle.assertions.length || bundle.assertions.some((a) => !a.passed)) return "verification bundle has no passing assertions";
	if (!bundle.artifacts.length) return "verification bundle has no uploaded artifacts";
	if (bundle.stage === "production" && bundle.observed_release_sha !== bundle.candidate_sha) return "production observed another release";
	if (bundle.stage === "candidate") {
		const control = bundle.negative_control;
		if (!control) return "verification bundle has no paired negative control";
		if (control.unfixed.sha !== bundle.trusted_base_sha || control.candidate.sha !== bundle.candidate_sha)
			return "negative control ran on other revisions";
		if (control.unfixed.exit_code === 0 || control.unfixed.exit_code === null) return "negative control did not fail on the unfixed revision";
		if (control.candidate.exit_code !== 0) return "negative control did not pass on the candidate";
		if (!bundle.harness) return "verification bundle has no model and harness identity";
	}
	return null;
}

const CHUNK = 12000;
export class EvidenceRefused extends Error {}
export async function uploadArtifacts(
	files: { name: string; content: Buffer }[],
	store: (payload: Record<string, unknown>) => Promise<string>,
): Promise<{ artifacts: ArtifactRef[]; uncovered: string[] }> {
	const artifacts: ArtifactRef[] = [];
	const uncovered: string[] = [];
	for (const file of files) {
		const digest = sha256(file.content);
		const text = file.content.toString("utf8");
		if (!Buffer.from(text, "utf8").equals(file.content)) {
			uncovered.push(`artifact ${file.name.slice(0, 200)} sha256:${digest} is binary and was not uploaded`);
			continue;
		}
		const parts = Math.max(1, Math.ceil(text.length / CHUNK));
		if (parts > 64) {
			uncovered.push(`artifact ${file.name.slice(0, 200)} sha256:${digest} exceeds the upload bound`);
			continue;
		}
		const ids: string[] = [];
		try {
			for (let part = 0; part < parts; part++)
				ids.push(await store({ artifact: file.name, sha256: digest, part, parts, content: text.slice(part * CHUNK, (part + 1) * CHUNK) }));
			artifacts.push({ name: file.name, sha256: digest, bytes: file.content.length, evidence_ids: ids });
		} catch (error) {
			if (!(error instanceof EvidenceRefused)) throw error;
			uncovered.push(`artifact ${file.name.slice(0, 200)} sha256:${digest} was refused by the ledger`);
		}
	}
	return { artifacts, uncovered };
}
