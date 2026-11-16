import { randomUUID } from "node:crypto";
import type { RepoContext } from "../config/index.js";
import { buildSnapshot, sandboxClient } from "../sandbox/index.js";
import { accountDaily, costPolicy, hostLedger } from "./accounting.js";
import { Budget, upperBound } from "./budget.js";
import { Lease } from "./lease.js";

export async function setupSnapshot(repo: RepoContext, sha: string) {
	const ledger = hostLedger();
	await accountDaily(ledger);
	const reserve = upperBound(0.316, 3600) + upperBound(0.4, 3600) + costPolicy().sandboxTrafficUsd;
	const result = await ledger.claim({
		event_id: `factory:snapshot:${repo.fullName}:${sha}`,
		connector: "factory_snapshot",
		linear_issue: "NOR-1436",
		condition_hash: `${repo.fullName}:${sha}`,
		reserve_usd: reserve,
		tool_allowance_usd: 0,
		lease_seconds: 3600,
	});
	if (result.status === "blocked" && result.state?.reason?.startsWith("Snapshot allowance accounted: "))
		return { snapshotId: result.state.reason.slice(30), repo: repo.fullName, sha };
	if (result.status !== "claimed") throw new Error("Snapshot setup admission refused");
	const claim = await ledger.own(result, 3600);
	if (!claim) throw new Error("Snapshot setup has no active owner");
	const lease = new Lease(ledger, claim, 3600, 3600);
	const budget = new Budget(claim, lease);
	lease.start();
	try {
		if (claim.state.resource_charges.length || claim.state.cleanup_only) {
			let unresolved = false;
			for (const resource of claim.state.resource_charges) {
				if (resource.kind === "setup_workflow" || resource.status === "terminated") continue;
				if (resource.kind !== "render_builder" || !resource.resource_id) {
					unresolved = true;
					continue;
				}
				try {
					await sandboxClient().terminate(resource.resource_id);
					await sandboxClient().confirmTerminated(resource.resource_id);
					await lease.checkpoint({ resource_charges: [{ ...resource, status: "terminated" }] });
				} catch {
					unresolved = true;
				}
			}
			if (!unresolved && !lease.signal.aborted)
				await lease.exclusive(() =>
					ledger.finish(claim, "blocked", "Interrupted snapshot resources terminated; build result unverified", budget.charged()),
				);
			throw new Error("Interrupted snapshot setup requires resource inspection before a new build revision");
		}
		await budget.reserve("setup_host", "setup_workflow", upperBound(0.4, 3600));
		const key = `builder-${randomUUID()}`;
		const update = await budget.reserve(key, "render_builder", upperBound(0.316, 3600) + costPolicy().sandboxTrafficUsd);
		const built = await buildSnapshot(sandboxClient(), repo, sha, {
			signal: lease.signal,
			allocation: {
				name: `nr-tmp-${key}`,
				started: async (id) => {
					await lease.trackCleanup(async () => {
						await sandboxClient().terminate(id);
						await sandboxClient().confirmTerminated(id);
					});
					await update("started", id);
				},
				terminated: (id) => update("terminated", id),
			},
		});
		await lease.exclusive(() => ledger.finish(claim, "blocked", `Snapshot allowance accounted: ${built.id}`, budget.charged()));
		return { snapshotId: built.id, repo: repo.fullName, sha };
	} finally {
		await lease.stop();
	}
}
