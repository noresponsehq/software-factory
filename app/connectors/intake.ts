import { createHash } from "node:crypto";
import { z } from "zod";
import { config, requireEnv, requireRepo } from "../config/index.js";
import { githubFor } from "../github/index.js";
import { Claimed, Ledger } from "./ledger.js";
import { Linear } from "./linear.js";

const marker = (text: string) => /<!--\s*connector:([a-z0-9_]+)\s*-->/.exec(text)?.[1];
const digest = (text: string) => createHash("sha256").update(text).digest("hex");
export async function intake(start: (input: object, key: string) => Promise<unknown>, after = 0) {
	if (!config.connectors) throw new Error("Connector mode is not configured");
	const repoName = Object.keys(config.repos)[0];
	if (!repoName) throw new Error("No connector repository configured");
	const installation = z.coerce.number().int().positive().parse(requireEnv("FACTORY_GITHUB_INSTALLATION_ID"));
	const repo = requireRepo(repoName, installation);
	const gh = githubFor(repo);
	const linear = new Linear(requireEnv("LINEAR_API_KEY"));
	const ledger = new Ledger(requireEnv("NR_LEDGER_URL"), requireEnv("NR_FACTORY_OPERATOR_TOKEN"));
	const base = {
		repo: repoName,
		installation_id: installation,
		actor: requireEnv("FACTORY_ACTOR"),
		reserve_usd: config.connectors.reserveUsd,
		tool_allowance_usd: config.connectors.toolAllowanceUsd,
		lease_seconds: 3600,
	};
	const assigned = await linear.query(
		'query($assignee:ID!){issues(first:100,filter:{assignee:{id:{eq:$assignee}},state:{type:{nin:["completed","canceled"]}}}){nodes{identifier title description updatedAt}}}',
		{ assignee: requireEnv("FACTORY_LINEAR_ASSIGNEE") },
	);
	const issues = z
		.object({
			issues: z.object({
				nodes: z.array(z.object({ identifier: z.string(), title: z.string(), description: z.string().nullable(), updatedAt: z.string() })),
			}),
		})
		.parse(assigned).issues.nodes;
	for (const issue of issues) {
		const connector = marker(issue.description ?? "");
		if (!connector) continue;
		const event_id = `linear:${issue.identifier}:${digest(issue.description ?? "")}`;
		await start(
			{
				...base,
				event_id,
				connector,
				linear_issue: issue.identifier,
				condition_hash: digest(issue.description ?? ""),
				task: `${issue.title}\n${issue.description ?? ""}`,
			},
			event_id,
		);
	}
	const github = z
		.array(z.object({ number: z.number().int(), body: z.string().nullable(), title: z.string(), pull_request: z.unknown().optional() }))
		.parse(await gh.http.json("GET", `/repos/${repoName}/issues`, { query: { labels: config.connectors.marker, state: "open", per_page: 100 } }));
	for (const issue of github) {
		if (issue.pull_request) continue;
		const connector = marker(issue.body ?? "");
		if (!connector) continue;
		const linear_issue =
			/\bNOR-\d+\b/.exec(issue.body ?? "")?.[0] ??
			(await linear.ensure(connector, digest(issue.body ?? ""), requireEnv("FACTORY_LINEAR_TEAM"), requireEnv("FACTORY_LINEAR_ASSIGNEE")));
		const event_id = `github:${repoName}:${issue.number}:${digest(issue.body ?? "")}`;
		await start(
			{ ...base, event_id, connector, linear_issue, condition_hash: digest(issue.body ?? ""), task: `${issue.title}\n${issue.body ?? ""}` },
			event_id,
		);
	}
	const health = z
		.object({
			events: z.array(z.object({ event_id: z.string(), connector: z.string(), condition_hash: z.string(), rev: z.number().int() })),
			next: z.number().int(),
		})
		.parse(await ledger.call(`events?after=${z.number().int().nonnegative().parse(after)}`));
	for (const event of health.events) {
		const issue = issues.find((i) => marker(i.description ?? "") === event.connector);
		const linear_issue =
			issue?.identifier ??
			(await linear.ensure(event.connector, event.condition_hash, requireEnv("FACTORY_LINEAR_TEAM"), requireEnv("FACTORY_LINEAR_ASSIGNEE")));
		await start(
			{
				...base,
				event_id: event.event_id,
				connector: event.connector,
				condition_hash: event.condition_hash,
				linear_issue,
				task: issue ? `${issue.title}\n${issue.description ?? ""}` : `Repair ${event.connector}; read its ledger brief and current controls`,
			},
			event.event_id,
		);
	}
	const pending = z
		.object({
			runs: z.array(
				Claimed.extend({
					state: Claimed.shape.state.extend({
						event_id: z.string(),
						connector: z.string(),
						linear_issue: z.string(),
						condition_hash: z.string(),
						reserve_usd: z.number(),
						tool_allowance_usd: z.number(),
					}),
				}),
			),
		})
		.parse(await ledger.call("runs?unfinished=true"));
	for (const run of pending.runs) {
		if (["research", "implementation", "review"].includes(run.state.phase) && new Date(run.expires_at).getTime() > Date.now()) continue;
		const issue = issues.find((i) => i.identifier === run.state.linear_issue);
		await start(
			{
				...base,
				event_id: run.state.event_id,
				connector: run.state.connector,
				linear_issue: run.state.linear_issue,
				condition_hash: run.state.condition_hash,
				reserve_usd: run.state.reserve_usd,
				tool_allowance_usd: run.state.tool_allowance_usd,
				task: issue ? `${issue.title}\n${issue.description ?? ""}` : `Continue ${run.state.linear_issue}; read existing notes and PR state`,
			},
			`continue:${run.run_id}:${run.state.version}`,
		);
	}
	return { next: health.next };
}
