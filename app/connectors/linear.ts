import { createHash } from "node:crypto";
import { z } from "zod";

export class Linear {
	constructor(
		private readonly token: string,
		private readonly request: typeof fetch = fetch,
	) {}
	async query(query: string, variables: Record<string, unknown>) {
		const response = await this.request("https://api.linear.app/graphql", {
			method: "POST",
			headers: { Authorization: this.token, "Content-Type": "application/json" },
			body: JSON.stringify({ query, variables }),
			signal: AbortSignal.timeout(30000),
			redirect: "error",
		});
		if (!response.ok) throw new Error(`Linear returned ${response.status}`);
		const result = z
			.object({ data: z.record(z.string(), z.unknown()).optional(), errors: z.array(z.unknown()).optional() })
			.parse(await response.json());
		if (result.errors?.length || !result.data) throw new Error("Linear operation failed");
		return result.data;
	}
	async ensure(connector: string, condition: string, teamId: string, assigneeId: string) {
		const hex = createHash("sha256").update(`factory:${connector}:${condition}`).digest("hex");
		const id = `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-a${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
		const existing = await this.query("query($id:String!){issue(id:$id){identifier}}", { id }).catch(() => undefined);
		if (existing?.issue) return z.object({ identifier: z.string() }).parse(existing.issue).identifier;
		const created = await this.query("mutation($input:IssueCreateInput!){issueCreate(input:$input){success issue{identifier}}}", {
			input: {
				id,
				teamId,
				assigneeId,
				title: `Restore ${connector} connector reliability`,
				description: `<!-- connector:${connector} -->\n\nThe connector health condition ${condition} requires investigation. Preserve source fields and distinguish unavailable from absent.\n\n## Done when\n\n- Research and implementation pass the connector gates.\n- A fresh independent verifier proves the changed boundary.\n- The ready PR merges and production release plus search checks pass.`,
			},
		});
		return z.object({ issueCreate: z.object({ success: z.literal(true), issue: z.object({ identifier: z.string() }) }) }).parse(created).issueCreate
			.issue.identifier;
	}

	async complete(identifier: string, evidence: string[]) {
		if (!evidence.length) throw new Error("Linear completion requires production evidence");
		const result = await this.query("query($id:String!){issue(id:$id){id team{states{nodes{id type}}}}}", { id: identifier });
		const issue = z
			.object({
				issue: z.object({ id: z.string(), team: z.object({ states: z.object({ nodes: z.array(z.object({ id: z.string(), type: z.string() })) }) }) }),
			})
			.parse(result).issue;
		const completed = issue.team.states.nodes.find((s) => s.type === "completed");
		if (!completed) throw new Error("Linear team has no completed state");
		const updated = await this.query("mutation($id:String!,$state:String!){issueUpdate(id:$id,input:{stateId:$state}){success}}", {
			id: issue.id,
			state: completed.id,
		});
		if (!z.object({ issueUpdate: z.object({ success: z.literal(true) }) }).safeParse(updated).success)
			throw new Error("Linear did not confirm completion");
	}
}
