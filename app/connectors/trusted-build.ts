import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { z } from "zod";
import type { GitHubHttp } from "../github/index.js";
import { type OpenedSandbox, shq } from "../sandbox/index.js";
import { FactoryBlocked } from "./failure.js";
import { Control } from "./probe-assertions.js";
import { pinControls, type TrustedControl } from "./trusted-controls.js";

const generated = new Set([
	"apps/identity/internal/connectors/folders.go",
	"apps/console/src/api/connectors.json",
	"apps/identity/internal/signuphost/golden.json",
]);
const IDENTITY = "apps/identity/";
const MODULE = "github.com/noresponsehq/noresponse/apps/identity/";
const MAX_SHARED_CONNECTORS = 25;
export type ChangeScope = { kind: "connector" | "shared"; packages: string[] };

export function changeScope(paths: string[], connector: string): ChangeScope {
	if (!/^[a-z0-9_]+$/.test(connector)) throw new Error("Invalid connector policy");
	const own = `${IDENTITY}internal/connectors/${connector}`;
	if (!paths.length) throw new Error("Candidate changes nothing");
	const packages = new Set<string>();
	for (const path of paths) {
		if (generated.has(path)) continue;
		const parts = path.split("/");
		if (
			!path.startsWith(`${IDENTITY}internal/`) ||
			path.startsWith(`${IDENTITY}internal/connector/`) ||
			!path.endsWith(".go") ||
			parts.some((p) => !p || p === "." || p === "..") ||
			!/^[A-Za-z0-9_-]+\.go$/.test(parts[parts.length - 1] as string)
		)
			throw new Error("Changes outside Identity's connector and adapter packages require an independently reviewed host policy");
		if (!path.endsWith("_test.go")) packages.add(parts.slice(0, -1).join("/"));
	}
	if (!packages.size) packages.add(own);
	const sorted = [...packages].sort();
	return { kind: sorted.length === 1 && sorted[0] === own ? "connector" : "shared", packages: sorted };
}

export function affectedConnectors(listing: string, connectors: string[], packages: string[], connector: string) {
	const changed = new Set(packages.map((p) => MODULE + p.slice(IDENTITY.length)));
	const deps = new Map(
		listing
			.split("\n")
			.filter(Boolean)
			.map((line) => {
				const [path, ...rest] = line.trim().split(/\s+/);
				return [path as string, new Set([path as string, ...rest])];
			}),
	);
	const packageOf = (id: string) =>
		[`${MODULE}internal/connectors/${id}`, `${MODULE}internal/${id}`, `${MODULE}internal/connectors`].find((p) => deps.has(p));
	const selected = [...new Set(connectors)].filter((id) => {
		const pkg = packageOf(id);
		return pkg !== undefined && [...changed].some((c) => deps.get(pkg)?.has(c));
	});
	if (!selected.includes(connector)) selected.push(connector);
	if (selected.length > MAX_SHARED_CONNECTORS)
		throw new FactoryBlocked(`The shared change reaches ${selected.length} connectors; split it below ${MAX_SHARED_CONNECTORS}`);
	return selected.sort();
}

export type ProbeTarget = { connector: string; control: Control; trusted: TrustedControl[] };
const Policy = z.strictObject({ trials: z.number().int().min(5).max(10), admitted_ms: z.number().int().positive() });

export async function trustedBuild(
	sandbox: OpenedSandbox,
	http: GitHubHttp,
	repo: string,
	head: string,
	connector: string,
	controlsOf: (connector: string) => Promise<TrustedControl[]>,
) {
	const trusted = sandbox.headSha;
	const compare = z
		.object({ files: z.array(z.object({ filename: z.string(), previous_filename: z.string().optional() })).max(299) })
		.parse(await http.json("GET", `/repos/${repo}/compare/${trusted}...${head}`));
	const scope = changeScope(
		compare.files.flatMap((f) => (f.previous_filename ? [f.filename, f.previous_filename] : [f.filename])),
		connector,
	);
	const tree = z
		.object({
			truncated: z.literal(false),
			tree: z.array(z.object({ path: z.string(), mode: z.string(), type: z.string(), sha: z.string().regex(/^[a-f0-9]{40}$/) })),
		})
		.parse(await http.json("GET", `/repos/${repo}/git/trees/${head}`, { query: { recursive: "1" } }));
	const inPackage = (path: string, pkg: string) => path.startsWith(`${pkg}/`) && !path.slice(pkg.length + 1).includes("/");
	const files = tree.tree.filter((f) => scope.packages.some((p) => inPackage(f.path, p)) && f.path.endsWith(".go") && !f.path.endsWith("_test.go"));
	if (
		!files.length ||
		files.length > 300 ||
		files.some((f) => f.type !== "blob" || f.mode !== "100644" || !/^[A-Za-z0-9_-]+\.go$/.test(f.path.split("/").pop() as string))
	)
		throw new Error("Candidate overlay must contain regular Go files from the changed packages");
	const mainPath = "/opt/factory/repo/apps/identity/cmd/probe/main.go";
	const main = (await sandbox.download(mainPath)).toString();
	if (main.split("func main() {").length !== 2) throw new Error("Trusted probe entry point changed");
	await sandbox.upload(mainPath, main.replace("func main() {", "func originalProbeMain() {"));
	await sandbox.upload(
		"/opt/factory/repo/apps/identity/cmd/probe/factory_rpc.go",
		await readFile(new URL("../../sandbox/probe-rpc.go", import.meta.url)),
	);
	await sandbox.upload("/opt/factory/app/control-pin.go", await readFile(new URL("../../sandbox/control-pin.go", import.meta.url)));
	const pinned = scope.packages.filter((p) => /^apps\/identity\/internal\/connectors\/[a-z0-9_]+$/.test(p));
	const pin = (pkg: string) =>
		sandbox.exec(`go run /opt/factory/app/control-pin.go ${shq(`/opt/factory/repo/${pkg}/`)}`, { asRunner: true, timeoutMs: 120000 });
	const originalPins = new Map<string, string>();
	for (const pkg of pinned) {
		const result = await pin(pkg);
		if (result.exitCode === 0) originalPins.set(pkg, result.stdout);
	}
	const exporter = await sandbox.exec("cd apps/identity && go build -o /tmp/factory-control ./cmd/probe && /tmp/factory-control policy", {
		asRunner: true,
		timeoutMs: 600000,
	});
	if (exporter.exitCode !== 0) throw new Error("Trusted main control exporter failed to build");
	const policy = Policy.parse(JSON.parse(exporter.stdout));

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
		if (size > 10000000) throw new Error("Candidate overlay exceeds limit");
		payloads.push({ path: file.path, data });
	}
	for (const pkg of scope.packages) {
		const prepare = await sandbox.exec(`mkdir -p ${shq(pkg)} && find ${shq(pkg)} -maxdepth 1 -type f -name '*.go' ! -name '*_test.go' -delete`);
		if (prepare.exitCode !== 0) throw new Error("Cannot prepare trusted candidate overlay");
	}
	for (const file of payloads) await sandbox.upload(`/opt/factory/repo/${file.path}`, file.data);
	const candidatePins = new Map<string, string>();
	for (const pkg of originalPins.keys()) {
		const result = await pin(pkg);
		if (result.exitCode === 0) candidatePins.set(pkg, result.stdout);
	}

	const registered = tree.tree
		.filter((f) => /^apps\/identity\/internal\/connectors\/[a-z0-9_]+\/[A-Za-z0-9_-]+\.go$/.test(f.path) && !f.path.endsWith("_test.go"))
		.map((f) => f.path.split("/")[4]);
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
	let selected = [connector];
	if (scope.kind === "shared") {
		const listing = await sandbox.exec(`cd apps/identity && go list -f '{{.ImportPath}} {{join .Deps " "}}' ./internal/...`, {
			asRunner: true,
			timeoutMs: 600000,
		});
		const ids = await sandbox.exec("/tmp/factory-control connectors", { asRunner: true, timeoutMs: 60000 });
		if (listing.exitCode !== 0 || ids.exitCode !== 0) throw new Error("Cannot list the connectors a shared change reaches");
		selected = affectedConnectors(listing.stdout, [...z.array(z.string()).parse(JSON.parse(ids.stdout)), connector], scope.packages, connector);
	}
	const targets: ProbeTarget[] = [];
	for (const id of selected) {
		const ledgerControls = await controlsOf(id);
		if (ledgerControls.length) {
			const pinnedControls = pinControls(id, ledgerControls);
			const declared = await sandbox.exec(`/tmp/factory-control control ${shq(id)}`, { asRunner: true, timeoutMs: 60000 });
			const known = declared.exitCode === 0 ? Control.parse(JSON.parse(declared.stdout)).known : null;
			const fields = known?.Fields ?? [];
			const by = (pinnedControls[0] as TrustedControl).by;
			targets.push({
				connector: id,
				trusted: pinnedControls,
				control: { known: { By: by, Present: "", Absent: "", Fields: fields, Supplied: true, PresentOnly: false, Paid: known?.Paid ?? false }, ...policy },
			});
			continue;
		}
		const pkg = `apps/identity/internal/connectors/${id}`;
		if (pinned.includes(pkg) && (!originalPins.has(pkg) || candidatePins.get(pkg) !== originalPins.get(pkg)))
			throw new FactoryBlocked(
				originalPins.has(pkg)
					? "Candidate changed a trusted AST-pinned control declaration"
					: `New or dynamic control of ${id} needs a trusted control in the ledger`,
				"missing_trusted_control",
			);
		const declared = await sandbox.exec(`/tmp/factory-control control ${shq(id)}`, { asRunner: true, timeoutMs: 60000 });
		if (declared.exitCode !== 0) throw new FactoryBlocked(`Trusted main has no control for ${id}`, "missing_trusted_control");
		targets.push({ connector: id, trusted: [], control: Control.parse(JSON.parse(declared.stdout)) });
	}
	const freeze = await sandbox.exec("chown -R root:root /opt/factory/repo && chmod -R a-w /opt/factory/repo");
	if (freeze.exitCode !== 0) throw new Error("Cannot freeze trusted harness and candidate overlay");
	return {
		targets,
		scope,
		trusted_sha: trusted,
		candidate_sha: head,
		control_digests: Object.fromEntries([...originalPins].map(([pkg, out]) => [pkg, createHash("sha256").update(out).digest("hex")])),
		control_revs: Object.fromEntries(targets.map((t) => [t.connector, t.trusted.map((c) => c.rev)])),
		overlay: files.map((f) => ({ path: f.path, sha: f.sha })),
	};
}
