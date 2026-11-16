import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { z } from "zod";
import type { GitHubHttp } from "../github/index.js";
import { type OpenedSandbox, shq } from "../sandbox/index.js";
import { FactoryBlocked } from "./failure.js";
import { Control } from "./probe-assertions.js";

const generated = new Set([
	"apps/identity/internal/connectors/folders.go",
	"apps/console/src/api/connectors.json",
	"apps/identity/internal/signuphost/golden.json",
]);
export function connectorScope(paths: string[], connector: string) {
	if (!/^[a-z0-9_]+$/.test(connector)) throw new Error("Invalid connector policy");
	const prefix = `apps/identity/internal/connectors/${connector}/`;
	if (
		!paths.length ||
		paths.some(
			(path) =>
				!generated.has(path) &&
				(!path.startsWith(prefix) ||
					path
						.slice(prefix.length)
						.split("/")
						.some((p) => !p || p === "." || p === "..")),
		)
	)
		throw new Error("Shared connector changes require an independently reviewed host policy");
}

export async function trustedBuild(sandbox: OpenedSandbox, http: GitHubHttp, repo: string, head: string, connector: string) {
	const trusted = sandbox.headSha;
	const compare = z
		.object({ files: z.array(z.object({ filename: z.string(), previous_filename: z.string().optional() })).max(299) })
		.parse(await http.json("GET", `/repos/${repo}/compare/${trusted}...${head}`));
	connectorScope(
		compare.files.flatMap((f) => (f.previous_filename ? [f.filename, f.previous_filename] : [f.filename])),
		connector,
	);
	const tree = z
		.object({
			truncated: z.literal(false),
			tree: z.array(z.object({ path: z.string(), mode: z.string(), type: z.string(), sha: z.string().regex(/^[a-f0-9]{40}$/) })),
		})
		.parse(await http.json("GET", `/repos/${repo}/git/trees/${head}`, { query: { recursive: "1" } }));
	const prefix = `apps/identity/internal/connectors/${connector}/`;
	const files = tree.tree.filter((f) => f.path.startsWith(prefix) && f.path.endsWith(".go") && !f.path.endsWith("_test.go"));
	if (
		!files.length ||
		files.length > 100 ||
		files.some((f) => f.type !== "blob" || f.mode !== "100644" || !/^[A-Za-z0-9_-]+\.go$/.test(f.path.slice(prefix.length)))
	)
		throw new Error("Connector overlay must contain only regular package Go files");
	const mainPath = "/opt/factory/repo/apps/identity/cmd/probe/main.go";
	const main = (await sandbox.download(mainPath)).toString();
	if (main.split("func main() {").length !== 2) throw new Error("Trusted probe entry point changed");
	await sandbox.upload(mainPath, main.replace("func main() {", "func originalProbeMain() {"));
	await sandbox.upload(
		"/opt/factory/repo/apps/identity/cmd/probe/factory_rpc.go",
		await readFile(new URL("../../sandbox/probe-rpc.go", import.meta.url)),
	);
	await sandbox.upload("/opt/factory/app/control-pin.go", await readFile(new URL("../../sandbox/control-pin.go", import.meta.url)));
	const pinCommand = `go run /opt/factory/app/control-pin.go ${shq(`/opt/factory/repo/${prefix}`)}`;
	const originalPin = await sandbox.exec(pinCommand, { asRunner: true, timeoutMs: 120000 });
	if (originalPin.exitCode !== 0) throw new FactoryBlocked("New or dynamic connector controls need trusted host approval");
	const original = await sandbox.exec(
		`cd apps/identity && go build -o /tmp/factory-control ./cmd/probe && NR_SIGNUP_BUILD_VERSION=${trusted} /tmp/factory-control control ${shq(connector)}`,
		{ asRunner: true, timeoutMs: 600000 },
	);
	if (original.exitCode !== 0) throw new FactoryBlocked("Trusted main control export failed");
	const control = Control.parse(JSON.parse(original.stdout));

	const payloads: { path: string; data: Buffer }[] = [];
	let size = 0;
	for (const file of files) {
		const blob = z
			.object({ encoding: z.literal("base64"), content: z.string(), size: z.number().int().max(1000000) })
			.parse(await http.json("GET", `/repos/${repo}/git/blobs/${file.sha}`));
		const data = Buffer.from(blob.content, "base64");
		if (data.length !== blob.size || createHash("sha1").update(`blob ${data.length}\0`).update(data).digest("hex") !== file.sha)
			throw new Error("Candidate blob digest mismatch");
		size += data.length;
		if (size > 10000000) throw new Error("Connector overlay exceeds limit");
		payloads.push({ path: file.path, data });
	}
	const prepare = await sandbox.exec(`mkdir -p ${shq(prefix)} && find ${shq(prefix)} -maxdepth 1 -type f -name '*.go' ! -name '*_test.go' -delete`);
	if (prepare.exitCode !== 0) throw new Error("Cannot prepare trusted connector overlay");
	for (const file of payloads) await sandbox.upload(`/opt/factory/repo/${file.path}`, file.data);
	const candidatePin = await sandbox.exec(pinCommand, { asRunner: true, timeoutMs: 120000 });
	if (candidatePin.exitCode !== 0 || candidatePin.stdout !== originalPin.stdout)
		throw new FactoryBlocked("Candidate changed a trusted AST-pinned control declaration");

	const registered = tree.tree
		.filter((f) => /^apps\/identity\/internal\/connectors\/[a-z0-9_]+\/[A-Za-z0-9_-]+\.go$/.test(f.path) && !f.path.endsWith("_test.go"))
		.map((f) => f.path.split("/")[4]);
	// Only the selected package may differ from main. The main registry remains authoritative for all other packages.
	const current = await sandbox.download("/opt/factory/repo/apps/identity/internal/connectors/folders.go");
	const imports = [
		...current.toString().matchAll(/"github\.com\/noresponsehq\/noresponse\/apps\/identity\/internal\/connectors\/([a-z0-9_]+)"/g),
	].map((m) => m[1]);
	if (!registered.includes(connector)) throw new Error("Candidate connector is not registered");
	const folders = [...new Set([...imports, connector])].sort();
	await sandbox.upload(
		"/opt/factory/repo/apps/identity/internal/connectors/folders.go",
		`package connectors\n\nimport (\n${folders.map((f) => `\t_ "github.com/noresponsehq/noresponse/apps/identity/internal/connectors/${f}"`).join("\n")}\n)\n`,
	);
	const freeze = await sandbox.exec("chown -R root:root /opt/factory/repo && chmod -R a-w /opt/factory/repo");
	if (freeze.exitCode !== 0) throw new Error("Cannot freeze trusted harness and connector overlay");
	return {
		control,
		trusted_sha: trusted,
		candidate_sha: head,
		control_digest: createHash("sha256").update(originalPin.stdout).digest("hex"),
		overlay: files.map((f) => ({ path: f.path, sha: f.sha })),
	};
}
