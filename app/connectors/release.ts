import { z } from "zod";
import type { GitHubHttp } from "../github/index.js";

export async function released(http: GitHubHttp, repo: string, head: string) {
	const runs = z
		.object({
			workflow_runs: z.array(z.object({ id: z.number().int(), status: z.string(), conclusion: z.string().nullable(), html_url: z.string() })),
		})
		.parse(await http.json("GET", `/repos/${repo}/actions/workflows/identity-deploy.yml/runs`, { query: { per_page: 100 } }));
	for (const run of runs.workflow_runs) {
		const jobs = z
			.object({ jobs: z.array(z.object({ id: z.number().int(), name: z.string(), status: z.string(), conclusion: z.string().nullable() })) })
			.parse(await http.json("GET", `/repos/${repo}/actions/runs/${run.id}/jobs`, { query: { per_page: 100 } }));
		const plan = jobs.jobs.find((j) => j.name === "plan");
		if (plan?.status !== "completed") continue;
		const log = await http.text("GET", `/repos/${repo}/actions/jobs/${plan.id}/logs`);
		const match = /running: (\S*); candidate: ([a-f0-9]{40}); release: (true|false)/.exec(log);
		if (!match || match[2] !== head) continue;
		const deployment = jobs.jobs.find((j) => j.name === "release");
		if (run.status !== "completed") return { status: "pending" as const, url: run.html_url };
		const success = run.conclusion === "success" && (match[3] === "false" ? match[1] === head : deployment?.conclusion === "success");
		return { status: success ? ("passed" as const) : ("failed" as const), url: run.html_url };
	}
	return { status: "pending" as const, url: "" };
}
