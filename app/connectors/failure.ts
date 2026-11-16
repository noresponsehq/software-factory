export class FactoryFailure extends Error {
	constructor(
		readonly kind: "probe" | "ci" | "production" | "implementation" | "verification",
		readonly payload: Record<string, unknown>,
	) {
		super(`Factory ${kind} failed`);
	}
}
export class FactoryBlocked extends Error {}
