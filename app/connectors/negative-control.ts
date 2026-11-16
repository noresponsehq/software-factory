import { randomUUID } from "node:crypto";
import { REPO_DIR, type Sandbox, shq } from "../sandbox/index.js";
import { type NegativeControl, sha256 } from "./bundle.js";
import type { AgentResult } from "./claude.js";

export async function pairedNegativeControl(
	request: AgentResult["negative_control"],
	connector: string,
	unfixed: { sandbox: Sandbox; sha: string },
	candidate: { sandbox: Sandbox; sha: string },
): Promise<{ control: NegativeControl; logs: { name: string; content: Buffer }[] } | { refused: string; logs?: { name: string; content: Buffer }[] }> {
	if (!request) return { refused: "verifier supplied no negative control" };
	if (!/^[a-z0-9_]+$/.test(connector)) throw new Error("Invalid connector policy");
	const prefix = `apps/identity/internal/connectors/${connector}/`;
	if (
		request.test_paths.some(
			(path) =>
				!path.startsWith(prefix) ||
				!path.endsWith("_test.go") ||
				path
					.slice(prefix.length)
					.split("/")
					.some((part) => !part || part === "." || part === ".."),
		)
	)
		return { refused: "negative control tests must be test files in the connector folder" };
	for (const tree of [unfixed, candidate]) {
		const head = await tree.sandbox.exec("git rev-parse HEAD", { asRunner: true });
		if (head.exitCode !== 0 || head.stdout.trim() !== tree.sha) return { refused: "negative control checkout differs from its revision" };
	}
	const clean = await unfixed.sandbox.exec("git status --porcelain --untracked-files=all", { asRunner: true });
	if (clean.exitCode !== 0 || clean.stdout.trim()) return { refused: "negative control baseline is not an untouched checkout" };
	const tests = await Promise.all(
		request.test_paths.map(async (path) => ({ path, content: await candidate.sandbox.download(`${REPO_DIR}/${path}`) })),
	);
	const fixture = sha256(JSON.stringify(tests.map(({ path, content }) => [path, sha256(content)])));
	for (const { path, content } of tests) {
		const made = await unfixed.sandbox.exec(`mkdir -p ${shq(path.slice(0, path.lastIndexOf("/")))}`, { asRunner: true });
		if (made.exitCode !== 0) throw new Error("Cannot stage negative control tests");
		const staged = `/tmp/factory-negative-${randomUUID()}`;
		await unfixed.sandbox.upload(staged, content);
		try {
			const readable = await unfixed.sandbox.exec(`chmod 0444 ${shq(staged)}`);
			if (readable.exitCode !== 0) throw new Error("Cannot make negative control tests readable");
			const copied = await unfixed.sandbox.exec(`cp --remove-destination ${shq(staged)} ${shq(`${REPO_DIR}/${path}`)}`, { asRunner: true });
			if (copied.exitCode !== 0) throw new Error("Cannot install negative control tests as runner");
		} finally {
			await unfixed.sandbox.exec(`rm -f ${shq(staged)}`);
		}
	}
	const command = `cd apps/identity && go test -json -count=1 -run ${shq(request.run)} ./internal/connectors/${connector}/`;
	const run = async (sandbox: Sandbox) => {
		try {
			return await sandbox.exec(command, { asRunner: true, timeoutMs: 20 * 60 * 1000 });
		} catch {
			return { exitCode: null, stdout: "", stderr: "Negative control command did not finish" };
		}
	};
	const before = await run(unfixed.sandbox);
	const after = await run(candidate.sandbox);
	const logs = [
		{ name: "negative-control/unfixed.log", content: Buffer.from(`${before.stdout}\n${before.stderr}`) },
		{ name: "negative-control/candidate.log", content: Buffer.from(`${after.stdout}\n${after.stderr}`) },
	];
	const failures = testResults(before.stdout, "fail");
	const passes = testResults(after.stdout, "pass");
	if (before.exitCode !== 1 || after.exitCode !== 0 || !failures?.size || failures.size > 200 || !passes || [...failures].some((test) => test.length > 500 || !passes.has(test)))
		return { refused: "negative control requires the same named test to fail on the base and pass on the candidate without harness errors or skips", logs };
	return {
		control: {
			command,
			fixture_sha256: fixture,
			tests: [...failures].sort(),
			unfixed: { sha: unfixed.sha, exit_code: before.exitCode },
			candidate: { sha: candidate.sha, exit_code: after.exitCode },
		},
		logs,
	};
}

function testResults(output: string, outcome: "pass" | "fail"): Set<string> | null {
	if (output.length > 4 * 1024 * 1024) return null;
	try {
		const events = output.trim().split("\n").map((line) => JSON.parse(line));
		if (events.some((event) => event.Action === "skip" || event.Action === "build-fail" || event.FailedBuild)) return null;
		const ran = new Set(events.filter((event) => event.Action === "run" && typeof event.Test === "string").map((event) => `${event.Package}/${event.Test}`));
		return new Set(events.filter((event) => event.Action === outcome && typeof event.Test === "string" && ran.has(`${event.Package}/${event.Test}`)).map((event) => `${event.Package}/${event.Test}`));
	} catch {
		return null;
	}
}
