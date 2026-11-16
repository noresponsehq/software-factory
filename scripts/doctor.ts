/**
 * Read-only checks of a deployment. Never prints a secret; exits 1 when any check fails.
 *
 *   npm run doctor [-- --service gateway|workflows|intake|all] [--live [--revision <sha>]]
 *
 * Checks the environment it runs in: locally that's .env; in a service's Render Shell it's that service's env.
 * --live also checks that Render runs the intended revision (default: this checkout's HEAD) on every service, that the
 * Workflow registers every task on it, and runs the doctor task to prove the deployed factory reaches its dependencies.
 */
import { execFileSync } from "node:child_process";
import { parseArgs } from "node:util";
import { config } from "../app/config/index.js";
import { checkDeployment } from "./lib/deployment.js";
import { runDoctor } from "./lib/doctor.js";
import { errorMessage, Reporter } from "./lib/output.js";
import type { Service } from "./lib/requirements.js";

const { values } = parseArgs({
	options: { service: { type: "string", default: "all" }, live: { type: "boolean", default: false }, revision: { type: "string" } },
});

const SELECTIONS: Record<string, Service[]> = {
	gateway: ["gateway"],
	workflows: ["workflows"],
	intake: ["intake"],
	all: config.connectors ? ["gateway", "workflows", "intake"] : ["gateway", "workflows"],
};
const services = SELECTIONS[values.service ?? "all"];
if (!services) {
	console.error("--service must be gateway, workflows, intake, or all");
	process.exit(2);
}

const out = new Reporter();
try {
	if (values.live) {
		const revision = values.revision?.trim() || execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim();
		await checkDeployment({ env: process.env, revision }, out);
	}
	process.exitCode = await runDoctor(
		{
			env: process.env,
			services,
			repos: Object.keys(config.repos),
			baseBranches: Object.fromEntries(Object.entries(config.repos).map(([name, repo]) => [name, repo.baseBranch])),
		},
		out,
	);
} catch (error) {
	out.fail(`doctor crashed: ${errorMessage(error)}`);
	process.exitCode = 1;
}
