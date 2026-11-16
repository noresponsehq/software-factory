import { z } from "zod";
import type { GitHubHttp } from "../github/index.js";

const thread = z.object({
	id: z.string(),
	isResolved: z.boolean(),
	comments: z.object({ nodes: z.array(z.object({ body: z.string(), path: z.string().nullable().optional() })) }),
});
export async function reviewThreads(http: GitHubHttp, owner: string, name: string, number: number) {
	const result = z
		.object({
			data: z.object({
				repository: z.object({
					pullRequest: z.object({ reviewThreads: z.object({ nodes: z.array(thread), pageInfo: z.object({ hasNextPage: z.boolean() }) }) }),
				}),
			}),
		})
		.parse(
			await http.json("POST", "/graphql", {
				body: {
					query:
						"query($owner:String!,$name:String!,$number:Int!){repository(owner:$owner,name:$name){pullRequest(number:$number){reviewThreads(first:100){nodes{id isResolved comments(first:50){nodes{body path}}} pageInfo{hasNextPage}}}}}",
					variables: { owner, name, number },
				},
			}),
		);
	const threads = result.data.repository.pullRequest.reviewThreads;
	if (threads.pageInfo.hasNextPage) throw new Error("Review threads exceed bounded selection; requires operator review");
	return threads.nodes.filter((t) => !t.isResolved);
}
export async function resolveReviewedThreads(http: GitHubHttp, allowed: string[], addressed: string[], evidence: string) {
	if (addressed.some((id) => !allowed.includes(id))) throw new Error("Verifier named an unknown review thread");
	for (const id of addressed) {
		const reply = await http.json<{ errors?: unknown[] }>("POST", "/graphql", {
			body: {
				query: "mutation($id:ID!,$body:String!){addPullRequestReviewThreadReply(input:{pullRequestReviewThreadId:$id,body:$body}){comment{id}}}",
				variables: {
					id,
					body: `Fresh independent verification and trusted probe receipt: ${evidence}. The verifier reported this thread addressed by the published candidate.`,
				},
			},
		});
		if (reply.errors?.length) throw new Error("Review evidence reply refused");
		const resolve = await http.json<{ errors?: unknown[] }>("POST", "/graphql", {
			body: { query: "mutation($id:ID!){resolveReviewThread(input:{threadId:$id}){thread{id isResolved}}}", variables: { id } },
		});
		if (resolve.errors?.length) throw new Error("Review resolution refused");
	}
}
