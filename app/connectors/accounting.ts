import { createHash } from "node:crypto";
import { z } from "zod";
import { config, requireEnv } from "../config/index.js";
import { Ledger, RunEnvelope } from "./ledger.js";

export const DEFAULT_COSTS = { baselineDailyUsd: 1, storageDailyUsd: 0.5, dispatchDailyUsd: 1, sandboxTrafficUsd: 0.2, probeTrafficUsd: 0.2 };
export function costPolicy() {
	const policy = { ...DEFAULT_COSTS, ...config.connectors?.costs };
	for (const amount of Object.values(policy))
		if (!Number.isFinite(amount) || amount <= 0 || amount > 10) throw new Error("Factory cost estimates must be positive and at most USD10 each");
	return policy;
}
export function hostLedger() {
	return new Ledger(requireEnv("NR_LEDGER_URL"), requireEnv("NR_FACTORY_OPERATOR_TOKEN"));
}
const accounted = "Daily factory service, dispatch and storage allowance accounted";
export async function accountDaily(ledger = hostLedger(), now = new Date()) {
	const day = now.toISOString().slice(0, 10);
	const costs = costPolicy();
	const policy = createHash("sha256").update(JSON.stringify(costs)).digest("hex").slice(0, 16);
	const amounts = [
		{ key: "baseline", kind: "service_baseline", reserved_usd: costs.baselineDailyUsd },
		{ key: "storage", kind: "retained_storage", reserved_usd: costs.storageDailyUsd },
		{ key: "dispatch", kind: "dispatch_overhead", reserved_usd: costs.dispatchDailyUsd },
	];
	const previous = z
		.object({
			runs: z.array(
				RunEnvelope.extend({ state: RunEnvelope.shape.state.extend({ connector: z.string(), event_id: z.string(), reserve_usd: z.number() }) }),
			),
		})
		.parse(await ledger.call("runs?unfinished=true"));
	for (const run of previous.runs) {
		if (run.state.connector !== "factory_services" || run.state.event_id === `factory:services:${day}:${policy}`) continue;
		const prior = await ledger.own({ ...run, fresh: false }, 30);
		if (!prior) throw new Error("Previous daily accounting still has an active owner");
		await ledger.finish(prior, "blocked", "Previous daily allowance accounted", run.state.reserve_usd);
	}
	const total = amounts.reduce((sum, item) => sum + item.reserved_usd, 0);
	const result = await ledger.claim({
		event_id: `factory:services:${day}:${policy}`,
		connector: "factory_services",
		linear_issue: "NOR-1436",
		condition_hash: `${day}:${policy}`,
		reserve_usd: total,
		tool_allowance_usd: 0,
		lease_seconds: 30,
	});
	if (result.status === "blocked" && result.state?.reason === accounted) return;
	if (result.status !== "claimed") throw new Error("Daily factory allowance admission refused");
	const claim = await ledger.own(result, 30);
	if (!claim || claim.state.cleanup_only) throw new Error("Daily factory allowance has no active owner");
	await ledger.heartbeat(claim, 30, { resource_charges: amounts.map((item) => ({ ...item, status: "reserved" })) });
	await ledger.finish(claim, "blocked", accounted, total);
}
