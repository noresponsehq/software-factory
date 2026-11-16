import { REPO_DIR, type Sandbox, shq } from "../sandbox/index.js";
import { runVerify } from "../workflows/run-verify.js";
import { type NegativeControl, sha256 } from "./bundle.js";
import type { AgentResult } from "./claude.js";

export async function pairedNegativeControl(
	request: AgentResult["negative_control"],
	connector: string,
	unfixed: { sandbox: Sandbox; sha: string },
	candidate: { sandbox: Sandbox; sha: string },
): Promise<{ control: NegativeControl; logs: { name: string; content: Buffer }[] } | { refused: string }> {
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
	const tests = await Promise.all(
		request.test_paths.map(async (path) => ({ path, content: await candidate.sandbox.download(`${REPO_DIR}/${path}`) })),
	);
	const fixture = sha256(JSON.stringify(tests.map(({ path, content }) => [path, sha256(content)])));
	for (const { path, content } of tests) {
		const made = await unfixed.sandbox.exec(`mkdir -p ${shq(path.slice(0, path.lastIndexOf("/")))}`, { asRunner: true });
		if (made.exitCode !== 0) throw new Error("Cannot stage negative control tests");
		await unfixed.sandbox.upload(`${REPO_DIR}/${path}`, content);
	}
	const command = `cd apps/identity && go test -count=1 -run ${shq(request.run)} ./internal/connectors/${connector}/`;
	const [before] = await runVerify(unfixed.sandbox, [command]);
	const [after] = await runVerify(candidate.sandbox, [command]);
	if (!before || !after) throw new Error("Negative control did not run");
	return {
		control: {
			command,
			fixture_sha256: fixture,
			unfixed: { sha: unfixed.sha, exit_code: before.exitCode },
			candidate: { sha: candidate.sha, exit_code: after.exitCode },
		},
		logs: [
			{ name: "negative-control/unfixed.log", content: Buffer.from(before.output) },
			{ name: "negative-control/candidate.log", content: Buffer.from(after.output) },
		],
	};
}
