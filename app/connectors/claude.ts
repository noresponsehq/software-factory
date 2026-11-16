import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { z } from "zod";
import { type Sandbox, shq } from "../sandbox/index.js";

export const AgentResult = z.strictObject({
	status: z.enum(["implemented", "verified", "blocked"]),
	addressed_threads: z.array(z.string().min(1).max(256)).max(100).default([]),
	summary: z.string().min(1).max(10000),
	evidence: z.array(z.string().min(1).max(500)).max(100),
});
export type AgentResult = z.infer<typeof AgentResult>;

export async function runClaude(
	sandbox: Sandbox,
	input: {
		prompt: string;
		subscriptionToken: string;
		runToken: string;
		ledgerUrl: string;
		seconds: number;
	},
): Promise<AgentResult> {
	if (!input.subscriptionToken || !input.runToken) throw new Error("Subscription and run credentials are required");
	if (!Number.isInteger(input.seconds) || input.seconds < 1 || input.seconds > 3600) throw new Error("Invalid agent deadline");
	const dir = `/opt/factory/claude-${randomUUID()}`;
	const create = await sandbox.exec(`mkdir -m 700 ${shq(dir)}`);
	if (create.exitCode !== 0) throw new Error("Cannot prepare Claude runtime");
	try {
		await sandbox.upload(`${dir}/launch.mjs`, await readFile(new URL("../../sandbox/claude-launch.mjs", import.meta.url)));
		await sandbox.upload(`${dir}/input.json`, JSON.stringify({ ...input, schema: z.toJSONSchema(AgentResult) }));
		const result = await sandbox.exec(`/usr/bin/env -i PATH=/usr/local/bin:/usr/bin:/bin node ${shq(`${dir}/launch.mjs`)} ${shq(dir)}`, {
			timeoutMs: (input.seconds + 30) * 1000,
		});
		if (result.exitCode !== 0) throw new Error("Claude subscription run failed; no API fallback attempted");
		const output = z.object({ is_error: z.literal(false), structured_output: AgentResult }).parse(JSON.parse(result.stdout));
		return output.structured_output;
	} finally {
		await sandbox.exec(`rm -rf ${shq(dir)}`);
	}
}
