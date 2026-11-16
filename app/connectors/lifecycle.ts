import type { Claimed, State } from "./ledger.js";

export interface Candidate {
	head: string;
	evidence: string[];
}
export interface Review {
	passed: boolean;
	head: string;
	evidence: string[];
	reason: string;
}
export type PullState = { kind: "pending" } | { kind: "repair"; reason: string } | { kind: "merged"; head: string; merge: string };
export interface LifecyclePorts {
	checkpoint(patch: Partial<Omit<State, "version">>): Promise<void>;
	implement(reason?: string): Promise<Candidate>;
	verify(candidate: Candidate): Promise<Review>;
	ready(candidate: Candidate): Promise<{ number: number; url: string }>;
	disarm(pr: number): Promise<void>;
	autoMerge(pr: number, head: string): Promise<void>;
	pull(pr: number): Promise<PullState>;
	production(merge: string): Promise<{ status: "pending" | "failed" | "passed"; sha: string; evidence: string[] }>;
	closeLinear(evidence: string[]): Promise<void>;
	block(reason: string): Promise<void>;
}

export async function advance(claim: Claimed, ports: LifecyclePorts, repairRounds: number): Promise<"waiting" | "blocked" | "completed"> {
	const checkpoint = async (patch: Partial<Omit<State, "version">>) => {
		await ports.checkpoint(patch);
		Object.assign(claim.state, patch);
	};
	const block = async (reason: string) => {
		await ports.block(reason);
		return "blocked" as const;
	};
	if (["research", "implementation", "review"].includes(claim.state.phase)) {
		if (claim.state.candidate_pr) await ports.disarm(claim.state.candidate_pr);
		let reason: string | undefined = claim.state.repair_reason ?? undefined;
		let accepted: Candidate | undefined;
		for (let round = 0; round <= repairRounds; round++) {
			await checkpoint({ phase: "implementation" });
			const candidate = await ports.implement(reason);
			await checkpoint({ phase: "review", head_sha: candidate.head, evidence_ids: candidate.evidence });
			const review = await ports.verify(candidate);
			if (review.passed && review.head === candidate.head && review.evidence.length > 0) {
				accepted = { ...candidate, evidence: [...candidate.evidence, ...review.evidence] };
				break;
			}
			reason = review.reason || "Independent verification did not prove this head";
			await checkpoint({ repair_reason: reason });
		}
		if (!accepted) return block(reason ?? "Verification failed");
		const pr = await ports.ready(accepted);
		await checkpoint({ phase: "ci", candidate_pr: pr.number, candidate_url: pr.url, head_sha: accepted.head, evidence_ids: accepted.evidence });
	}
	if (claim.state.phase === "ci") {
		if (!claim.state.candidate_pr || !claim.state.head_sha) throw new Error("CI checkpoint lacks PR or head");
		const pull = await ports.pull(claim.state.candidate_pr);
		if (pull.kind === "pending") {
			await ports.autoMerge(claim.state.candidate_pr, claim.state.head_sha);
			return "waiting";
		}
		if (pull.kind === "repair") {
			await ports.disarm(claim.state.candidate_pr);
			await checkpoint({ phase: "implementation", repair_reason: pull.reason });
			return "waiting";
		}
		if (pull.head !== claim.state.head_sha) return block("Merged head differs from independently verified head");
		await checkpoint({ phase: "release", merge_sha: pull.merge });
	}
	if (claim.state.phase === "release") {
		if (!claim.state.merge_sha) throw new Error("Release checkpoint lacks merge SHA");
		const proof = await ports.production(claim.state.merge_sha);
		if (proof.status === "pending") return "waiting";
		if (proof.status !== "passed" || proof.sha !== claim.state.merge_sha || proof.evidence.length === 0)
			return block("Production did not prove the merged change");
		await checkpoint({ phase: "production_verified", evidence_ids: [...claim.state.evidence_ids, ...proof.evidence] });
	}
	if (claim.state.phase !== "production_verified") throw new Error("Unknown lifecycle checkpoint");
	await ports.closeLinear(claim.state.evidence_ids);
	return "completed";
}
