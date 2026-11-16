import { createHash } from "node:crypto";
import { z } from "zod";
import { EvidenceRefused } from "./bundle.js";

export const Phase = z.enum(["research", "implementation", "review", "ci", "release", "production_verified"]);
export const Resource = z.strictObject({
	key: z.string().min(1),
	kind: z.string().regex(/^[a-z_]{1,32}$/),
	reserved_usd: z.number().nonnegative(),
	status: z.enum(["reserved", "started", "terminated"]),
	resource_id: z.string().nullable().optional(),
});
const Reported = z.object({
	cleanup_only: z.boolean().optional(),
	resource_charges: z.array(Resource).optional(),
	repair_reason: z.string().nullable().optional(),
	version: z.number().int().nonnegative(),
	phase: Phase,
	candidate_pr: z.number().int().positive().nullable().optional(),
	candidate_url: z.string().url().nullable().optional(),
	head_sha: z
		.string()
		.regex(/^[a-f0-9]{40}$/)
		.nullable()
		.optional(),
	merge_sha: z
		.string()
		.regex(/^[a-f0-9]{40}$/)
		.nullable()
		.optional(),
	evidence_ids: z.array(z.string()).optional(),
});
export const State = Reported.required({ cleanup_only: true, resource_charges: true, evidence_ids: true });
export type State = z.infer<typeof State>;
export function mergeState(known: State, reported: z.infer<typeof Reported>): State {
	return {
		...reported,
		cleanup_only: reported.cleanup_only ?? known.cleanup_only,
		resource_charges: reported.resource_charges ?? known.resource_charges,
		evidence_ids: reported.evidence_ids ?? known.evidence_ids,
	};
}
export const ClaimInput = z.strictObject({
	event_id: z.string().min(1).max(256),
	connector: z
		.string()
		.regex(/^[a-z0-9_]+$/)
		.max(100),
	linear_issue: z.string().regex(/^NOR-\d+$/),
	condition_hash: z.string().min(1).max(256),
	reserve_usd: z.number().positive().max(50),
	tool_allowance_usd: z.number().nonnegative().default(0),
	lease_seconds: z.number().int().min(30).max(3600),
});
export const Claimed = z.object({
	status: z.literal("claimed"),
	run_id: z.string().regex(/^[a-zA-Z0-9_-]+$/),
	token: z.string().min(1),
	expires_at: z.union([z.string(), z.number()]),
	state: State,
});
export type Claimed = z.infer<typeof Claimed>;
export const RunEnvelope = Claimed.extend({ token: z.string().min(1).optional() });
export const ClaimResult = z.union([
	RunEnvelope.extend({ fresh: z.boolean() }),
	z.object({
		status: z.enum(["blocked", "failed", "completed"]),
		reason: z.string().optional(),
		state: z.object({ reason: z.string().nullable().optional() }).nullable().optional(),
	}),
]);

export class Ledger {
	constructor(
		private readonly url: string,
		private readonly operatorToken: string,
		private readonly request: typeof fetch = fetch,
	) {
		if (new URL(url).protocol !== "https:") throw new Error("Factory ledger requires HTTPS");
	}
	async call(path: string, body?: unknown): Promise<unknown> {
		const response = await this.request(`${this.url.replace(/\/$/, "")}/ledger/factory/${path}`, {
			method: body === undefined ? "GET" : "POST",
			headers: { Authorization: `Bearer ${this.operatorToken}`, "Content-Type": "application/json" },
			body: body === undefined ? undefined : JSON.stringify(body),
			signal: AbortSignal.timeout(30000),
			redirect: "error",
		});
		if (path === "evidence" && (response.status === 400 || response.status === 422)) throw new EvidenceRefused("Factory ledger refused evidence");
		if (!response.ok && !(path === "claim" && response.status === 409))
			throw new Error(`Factory ledger ${path.split("?")[0]} returned ${response.status}`);
		const result: unknown = await response.json();
		return path === "claim" && typeof result === "object" && result !== null ? { ...result, fresh: response.status === 201 } : result;
	}
	async claim(input: z.infer<typeof ClaimInput>) {
		return ClaimResult.parse(await this.call("claim", ClaimInput.parse(input)));
	}
	async own(result: z.infer<typeof ClaimResult>, leaseSeconds: number): Promise<Claimed | null> {
		if (result.status !== "claimed") return null;
		if (!result.fresh && new Date(result.expires_at).getTime() > Date.now()) return null;
		const claim = Claimed.parse(result);
		if (!result.fresh) await this.heartbeat(claim, leaseSeconds, {}, true);
		return claim;
	}

	async heartbeat(claim: Claimed, lease_seconds: number, patch: Partial<Omit<State, "version">> = {}, recover = false) {
		const result = z
			.object({
				status: z.literal("claimed"),
				run_id: z.string(),
				expires_at: Claimed.shape.expires_at,
				state: Reported,
				token: z.string().min(1).optional(),
			})
			.parse(
				await this.call("heartbeat", {
					run_id: claim.run_id,
					token: claim.token,
					expected_version: claim.state.version,
					lease_seconds,
					recover,
					...patch,
				}),
			);
		if (result.run_id !== claim.run_id) throw new Error("Factory lease changed owner");
		const { state, ...envelope } = result;
		Object.assign(claim, envelope, { state: mergeState(claim.state, state) });
	}
	async evidence(
		claim: Claimed,
		head_sha: string,
		kind: "probe" | "ci" | "release" | "production" | "implementation" | "verification",
		payload: Record<string, unknown>,
	) {
		const encoded = JSON.stringify(payload);
		if (Buffer.byteLength(encoded) > 16384) throw new Error("Evidence exceeds 16 KiB");
		const digest = createHash("sha256").update(encoded).digest("hex");
		const result = z.object({ evidence_id: z.string().min(1), state: Reported }).parse(
			await this.call("evidence", {
				run_id: claim.run_id,
				token: claim.token,
				expected_version: claim.state.version,
				head_sha,
				kind,
				digest,
				payload,
			}),
		);
		claim.state = mergeState(claim.state, result.state);
		return result.evidence_id;
	}

	async finish(claim: Claimed, outcome: "completed" | "blocked" | "failed", reason: string, actual_usd: number) {
		if (!Number.isFinite(actual_usd) || actual_usd < 0) throw new Error("Authoritative cost is required");
		return this.call("finish", {
			run_id: claim.run_id,
			token: claim.token,
			expected_version: claim.state.version,
			outcome,
			reason,
			charged_usd: actual_usd,
			cost_basis: "reserved_upper_bound",
		});
	}
}
