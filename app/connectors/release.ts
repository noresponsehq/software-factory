import { z } from "zod";
import type { GitHubHttp } from "../github/index.js";

export type ReleaseState =
	| { status: "pending" | "passed" | "failed"; url: string }
	| { status: "superseded"; url: string; requested: string; observed: string };

export async function contains(http: GitHubHttp, repo: string, older: string, newer: string) {
	const compare = z.object({ status: z.string() }).parse(await http.json("GET", `/repos/${repo}/compare/${older}...${newer}`));
	return compare.status === "ahead" || compare.status === "identical";
}

export async function released(http: GitHubHttp, repo: string, head: string): Promise<ReleaseState> {
	const runs = z
		.object({
			workflow_runs: z.array(z.object({ id: z.number().int(), status: z.string(), conclusion: z.string().nullable(), html_url: z.string() })),
		})
		.parse(await http.json("GET", `/repos/${repo}/actions/workflows/identity-deploy.yml/runs`, { query: { per_page: 100 } }));
	const later: { candidate: string; url: string }[] = [];
	for (const run of runs.workflow_runs) {
		const jobs = z
			.object({ jobs: z.array(z.object({ id: z.number().int(), name: z.string(), status: z.string(), conclusion: z.string().nullable() })) })
			.parse(await http.json("GET", `/repos/${repo}/actions/runs/${run.id}/jobs`, { query: { per_page: 100 } }));
		const plan = jobs.jobs.find((j) => j.name === "plan");
		if (plan?.status !== "completed") continue;
		const log = await http.text("GET", `/repos/${repo}/actions/jobs/${plan.id}/logs`);
		const match = /running: (\S*); candidate: ([a-f0-9]{40}); release: (true|false)/.exec(log);
		if (!match) continue;
		const deployment = jobs.jobs.find((j) => j.name === "release");
		const [, running, candidate, release] = match as unknown as [string, string, string, string];
		if (candidate !== head) {
			if (run.status === "completed" && run.conclusion === "success" && release === "true" && deployment?.conclusion === "success")
				later.push({ candidate, url: run.html_url });
			continue;
		}
		if (run.status !== "completed") return { status: "pending", url: run.html_url };
		if (release === "false" && running === head) return { status: run.conclusion === "success" ? "passed" : "failed", url: run.html_url };
		if (release === "true" && deployment?.conclusion !== "skipped" && run.conclusion !== "cancelled")
			return { status: run.conclusion === "success" && deployment?.conclusion === "success" ? "passed" : "failed", url: run.html_url };
		return (await supersededBy(http, repo, head, later)) ?? { status: "pending", url: run.html_url };
	}
	return (await supersededBy(http, repo, head, later)) ?? { status: "pending", url: "" };
}

async function supersededBy(http: GitHubHttp, repo: string, head: string, later: { candidate: string; url: string }[]): Promise<ReleaseState | null> {
	for (const newer of later)
		if (await contains(http, repo, head, newer.candidate))
			return { status: "superseded", url: newer.url, requested: head, observed: newer.candidate };
	return null;
}
