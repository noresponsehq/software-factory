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
export class FactoryBlocked extends Error {}
