import { createHash } from "node:crypto";
import { z } from "zod";

export const Phase = z.enum(["research", "implementation", "review", "ci", "release", "production_verified"]);
export const Resource = z.strictObject({
	key: z.string().min(1),
	kind: z.string().min(1),
	reserved_usd: z.number().nonnegative(),
	status: z.enum(["reserved", "started", "terminated"]),
	resource_id: z.string().nullable().optional(),
});
export const State = z.object({
	resource_charges: z.array(Resource).default([]),
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
	evidence_ids: z.array(z.string()).default([]),
});
export type State = z.infer<typeof State>;
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
export const ClaimResult = z.union([Claimed, z.object({ status: z.enum(["blocked", "failed", "completed"]), reason: z.string().optional() })]);

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
		if (!response.ok && !(path === "claim" && response.status === 409))
			throw new Error(`Factory ledger ${path.split("?")[0]} returned ${response.status}`);
		return response.json();
	}
	async claim(input: z.infer<typeof ClaimInput>) {
		return ClaimResult.parse(await this.call("claim", ClaimInput.parse(input)));
	}
	async heartbeat(claim: Claimed, lease_seconds: number, patch: Partial<Omit<State, "version">> = {}) {
		const result = z
			.object({
				status: z.literal("claimed"),
				run_id: z.string(),
				expires_at: Claimed.shape.expires_at,
				state: State,
				token: z.string().min(1).optional(),
			})
			.parse(
				await this.call("heartbeat", { run_id: claim.run_id, token: claim.token, expected_version: claim.state.version, lease_seconds, ...patch }),
			);
		if (result.run_id !== claim.run_id) throw new Error("Factory lease changed owner");
		Object.assign(claim, result);
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
		const result = z.object({ evidence_id: z.string().min(1), state: State }).parse(
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
		claim.state = result.state;
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
