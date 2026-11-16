import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { z } from "zod";
import { type Sandbox, shq } from "../sandbox/index.js";
import { type HarnessIdentity, sha256 } from "./bundle.js";

export const AgentResult = z.strictObject({
	status: z.enum(["implemented", "verified", "blocked"]),
	addressed_threads: z.array(z.string().min(1).max(256)).max(100).default([]),
	summary: z.string().min(1).max(10000),
	evidence: z.array(z.string().min(1).max(500)).max(100),
	negative_control: z
		.strictObject({
			test_paths: z.array(z.string().min(1).max(300)).min(1).max(20),
			run: z.string().regex(/^[A-Za-z0-9_|^$]{1,200}$/),
		})
		.nullable()
		.default(null),
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
		model: string;
	},
): Promise<{ result: AgentResult; harness: HarnessIdentity; skillDigests: string }> {
	if (!input.subscriptionToken || !input.runToken) throw new Error("Subscription and run credentials are required");
	if (!Number.isInteger(input.seconds) || input.seconds < 1 || input.seconds > 3600) throw new Error("Invalid agent deadline");
	if (!/^[a-z0-9.-]{1,100}$/.test(input.model)) throw new Error("Connector agents need an explicit model");
	const dir = `/opt/factory/claude-${randomUUID()}`;
	const create = await sandbox.exec(`mkdir -m 700 ${shq(dir)}`);
	if (create.exitCode !== 0) throw new Error("Cannot prepare Claude runtime");
	try {
		const launcher = await readFile(new URL("../../sandbox/claude-launch.mjs", import.meta.url));
		const version = await sandbox.exec("claude --version", { asRunner: true });
		const skills = await sandbox.exec("sha256sum .agents/skills/*/SKILL.md 2>/dev/null || true", { asRunner: true });
		if (version.exitCode !== 0 || !version.stdout.trim()) throw new Error("Cannot read the Claude Code version");
		const harness: HarnessIdentity = {
			harness: "claude_code",
			model: input.model,
			cli_version: version.stdout.trim().slice(0, 100),
			launcher_sha256: sha256(launcher),
			prompt_sha256: sha256(input.prompt),
			skills_sha256: sha256(skills.stdout),
			skills: skills.stdout.split("\n").filter((line) => /^[a-f0-9]{64}\s/.test(line)).length,
		};
		await sandbox.upload(`${dir}/launch.mjs`, launcher);
		await sandbox.upload(`${dir}/input.json`, JSON.stringify({ ...input, schema: z.toJSONSchema(AgentResult) }));
		const result = await sandbox.exec(`/usr/bin/env -i PATH=/usr/local/bin:/usr/bin:/bin node ${shq(`${dir}/launch.mjs`)} ${shq(dir)}`, {
			timeoutMs: (input.seconds + 30) * 1000,
		});
		if (result.exitCode !== 0) throw new Error("Claude subscription run failed; no API fallback attempted");
		const output = z.object({ is_error: z.literal(false), structured_output: AgentResult }).parse(JSON.parse(result.stdout));
		return { result: output.structured_output, harness, skillDigests: skills.stdout };
	} finally {
		await sandbox.exec(`rm -rf ${shq(dir)}`);
	}
}
