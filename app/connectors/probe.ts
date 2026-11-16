import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { z } from "zod";
import type { Sandbox } from "../sandbox/index.js";

const execute = promisify(execFile);
export interface ProbeInput {
	connector: string;
	head: string;
	goVersion: string;
	session?: string;
	proxies?: string;
}
export type HostExec = (args: string[]) => Promise<string>;
export function flyExec(token: string): HostExec {
	return async (args) => {
		try {
			const result = await execute("fly", args, {
				env: { PATH: process.env.PATH, HOME: process.env.HOME, FLY_API_TOKEN: token },
				timeout: 180000,
				maxBuffer: 8 * 1024 * 1024,
			});
			return result.stdout;
		} catch {
			throw new Error("Trusted Fly probe command failed");
		}
	};
}
export async function probe(
	sandbox: Sandbox,
	raw: ProbeInput,
	host: HostExec,
	charge: () => Promise<(status: "started" | "terminated", id: string) => Promise<void>>,
) {
	const input = z
		.strictObject({
			connector: z.string().regex(/^[a-z0-9_]+$/),
			head: z.string().regex(/^[a-f0-9]{40}$/),
			goVersion: z.string().regex(/^1\.\d+\.\d+$/),
			session: z.string().optional(),
			proxies: z.string().optional(),
		})
		.parse(raw);
	const build = await sandbox.exec(
		"cd apps/identity && CGO_ENABLED=0 GOOS=linux GOARCH=amd64 go build -o /tmp/factory-probe ./cmd/probe && tar -czf /tmp/factory-probe-source.tgz go.mod go.sum cmd contracts internal",
		{ asRunner: true, timeoutMs: 600000 },
	);
	if (build.exitCode !== 0) throw new Error("Candidate probe build failed");
	const binary = await sandbox.download("/tmp/factory-probe");
	const source = await sandbox.download("/tmp/factory-probe-source.tgz");
	if (binary.length > 100000000 || source.length > 100000000) throw new Error("Probe payload exceeds limit");
	const dir = await mkdtemp(join(tmpdir(), "nr-tmp-probe-"));
	let machine: string | undefined;
	let charged: Awaited<ReturnType<typeof charge>> | undefined;
	try {
		await writeFile(join(dir, "probe"), binary, { mode: 0o600 });
		await writeFile(join(dir, "source.tgz"), source, { mode: 0o600 });
		const files: string[] = [];
		const args = ["-connector", input.connector, "-test", "-trials", "5"];
		for (const [key, value] of [
			["session", input.session],
			["proxies", input.proxies],
		] as const) {
			if (value !== undefined) {
				await writeFile(join(dir, key), value, { mode: 0o600 });
				files.push("--file-local", `/secrets/${key}=${join(dir, key)}`);
				args.push(`-${key}`, `/secrets/${key}`);
			}
		}
		const listed = z.array(z.object({ state: z.string() })).parse(JSON.parse(await host(["machine", "list", "--app", "nr-probe", "--json"])));
		if (listed.filter((m) => !["stopped", "destroyed", "destroying"].includes(m.state)).length >= 8)
			throw new Error("Fly probe capacity unavailable");
		charged = await charge();
		const created = await host([
			"machine",
			"run",
			`golang:${input.goVersion}`,
			"--app",
			"nr-probe",
			"--region",
			"iad",
			"--name",
			`nr-tmp-${input.connector.slice(0, 20)}-${Date.now()}`,
			"--restart",
			"no",
			"--rm",
			"--detach",
			"--vm-size",
			"shared-cpu-4x",
			"--vm-memory",
			"4096",
			...files,
			"--entrypoint",
			"sh",
			"--",
			"-c",
			"sleep 900",
		]);
		machine = /Machine ID:\s*([a-f0-9]+)/.exec(created)?.[1];
		if (!machine) throw new Error("Fly returned no machine id");
		await charged("started", machine);
		await host(["machine", "wait", machine, "--app", "nr-probe", "--state", "started", "--wait-timeout", "2m"]);
		for (const name of ["probe", "source.tgz"])
			await host(["ssh", "sftp", "put", join(dir, name), `/root/${name}`, "--app", "nr-probe", "--machine", machine]);
		const command = `mkdir -p /work /secrets && cp /root/probe /work/probe && cp /root/source.tgz /work/source.tgz && chmod 755 /work/probe && chown -R 65534:65534 /work /secrets && setpriv --reuid=65534 --regid=65534 --clear-groups --no-new-privs --bounding-set=-all --inh-caps=-all --ambient-caps=-all -- sh -c "cd /work && tar -xzf source.tgz && NR_SIGNUP_BUILD_VERSION=${input.head} ./probe ${args.join(" ")}"`;
		const output = await host([
			"ssh",
			"console",
			"--app",
			"nr-probe",
			"--machine",
			machine,
			"-C",
			`sh -c '${command}; code=$?; printf "\\nNRPROBE_STATUS %s\\n" "$code"'`,
		]);
		const result = parseProbe(output, input.connector);
		return { head: input.head, region: "iad", binary_sha256: createHash("sha256").update(binary).digest("hex"), result };
	} finally {
		try {
			if (machine) {
				await host(["machine", "destroy", machine, "--app", "nr-probe", "--force"]);
				await charged?.("terminated", machine);
			}
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	}
}

export function parseProbe(output: string, connector: string) {
	const match = /\nNRPROBE_STATUS (\d+)\s*$/.exec(output);
	if (match?.[1] !== "0") throw new Error("Probe returned no successful remote exit");
	const result = z
		.object({
			connector: z.literal(connector),
			control: z.object({ verdict: z.literal("passed") }),
			admission: z.object({ passes: z.literal(true) }),
			tests: z.object({ pass: z.number().int().positive(), fail: z.literal(0), exit: z.literal(0), skip: z.number().int().nonnegative() }),
		})
		.parse(JSON.parse(output.slice(0, match.index)));
	return result;
}
