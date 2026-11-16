import type { FailureClass } from "./bundle.js";

export class FactoryFailure extends Error {
	constructor(
		readonly kind: "probe" | "ci" | "production" | "implementation" | "verification",
		readonly failureClass: FailureClass,
		readonly payload: Record<string, unknown>,
	) {
		super(`Factory ${kind} failed`);
	}
}
export type BlockedReason = "stale_control" | "untrusted_control" | "missing_trusted_control" | "paid_lookup_allowance" | "policy";
export class FactoryBlocked extends Error {
	constructor(
		message: string,
		readonly reason: BlockedReason = "policy",
	) {
		super(message);
	}
}
