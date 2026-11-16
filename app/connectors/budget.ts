import type { z } from "zod";
import type { Lease } from "./lease.js";
import type { Claimed, Resource } from "./ledger.js";

export const upperBound = (hourlyUsd: number, seconds: number) => {
	if (!Number.isFinite(hourlyUsd) || hourlyUsd <= 0 || !Number.isFinite(seconds) || seconds <= 0)
		throw new Error("Resource price and lifetime must be positive");
	return Math.ceil(((hourlyUsd * seconds) / 3600) * 1e6) / 1e6;
};
export class Budget {
	constructor(
		private readonly claim: Claimed,
		private readonly lease: Lease,
	) {}
	async reserve(key: string, kind: string, reserved_usd: number) {
		if (this.claim.state.resource_charges.some((r) => r.key === key))
			throw new Error("Resource already reserved; reconcile it before creating another");
		const resource: z.infer<typeof Resource> = { key, kind, reserved_usd, status: "reserved" };
		await this.lease.checkpoint({ resource_charges: [resource] });
		return async (status: "started" | "terminated", resource_id: string) => {
			await this.lease.checkpoint({ resource_charges: [{ ...resource, status, resource_id }] });
		};
	}
	charged() {
		return this.claim.state.resource_charges.reduce((sum, r) => sum + r.reserved_usd, 0);
	}
}
