import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { z } from "zod";
import type { Sandbox } from "../sandbox/index.js";
import { FactoryFailure } from "./failure.js";
import { assertProbe, Control } from "./probe-assertions.js";
import { TrustedControl } from "./trusted-controls.js";

const execute = promisify(execFile);
export interface ProbeInput {
	head: string;
	goVersion: string;
	targets: { connector: string; control: Control; trusted: TrustedControl[]; session?: string }[];
	proxies?: string;
}
export type HostExec = (args: string[]) => Promise<string>;
export function flyExec(token: string, signal?: AbortSignal): HostExec {
	return async (args) => {
		try {
			const result = await execute("fly", args, {
				env: { PATH: process.env.PATH, HOME: process.env.HOME, FLY_API_TOKEN: token },
				timeout: 180000,
				signal,
				maxBuffer: 8 * 1024 * 1024,
			});
			return result.stdout;
		} catch {
			throw new Error("Trusted Fly probe command failed");
		}
	};
}
export async function terminateProbe(host: HostExec, id: string) {
	const listed = z
		.array(z.object({ id: z.string(), state: z.string() }))
		.parse(JSON.parse(await host(["machine", "list", "--app", "nr-probe", "--json"])));
	if (!listed.some((machine) => machine.id === id && machine.state !== "destroyed")) return;
	await host(["machine", "destroy", id, "--app", "nr-probe", "--force"]);
	const after = z
		.array(z.object({ id: z.string(), state: z.string() }))
		.parse(JSON.parse(await host(["machine", "list", "--app", "nr-probe", "--json"])));
	if (after.some((machine) => machine.id === id && machine.state !== "destroyed"))
		throw new Error("Probe termination is unconfirmed; keep full reservation");
}

export async function probe(
	sandbox: Sandbox,
	raw: ProbeInput,
	host: HostExec,
	charge: () => Promise<{ name: string; update: (status: "started" | "terminated", id: string) => Promise<void> }>,
	cleanupHost: HostExec = host,
) {
	const input = z
		.strictObject({
			head: z.string().regex(/^[a-f0-9]{40}$/),
			goVersion: z.string().regex(/^1\.\d+\.\d+$/),
			targets: z
				.array(
					z.strictObject({
						connector: z.string().regex(/^[a-z0-9_]+$/),
						control: Control,
						trusted: z.array(TrustedControl),
						session: z.string().optional(),
					}),
				)
				.min(1)
				.max(25),
			proxies: z.string().optional(),
		})
		.parse(raw);
	const build = await sandbox.exec("cd apps/identity && CGO_ENABLED=0 GOOS=linux GOARCH=amd64 go build -buildvcs=false -o /tmp/factory-probe ./cmd/probe", {
		asRunner: true,
		timeoutMs: 600000,
	});
	if (build.exitCode !== 0) throw new Error("Candidate probe build failed");
	const binary = await sandbox.download("/tmp/factory-probe");
	if (binary.length > 100000000) throw new Error("Probe payload exceeds limit");
	const dir = await mkdtemp(join(tmpdir(), "nr-tmp-probe-"));
	let machine: string | undefined;
	let charged: Awaited<ReturnType<typeof charge>> | undefined;
	try {
		await writeFile(join(dir, "probe"), binary, { mode: 0o600 });
		await writeFile(join(dir, "as-runner.sh"), await readFile(new URL("../../sandbox/as-runner.sh", import.meta.url)), { mode: 0o600 });
		await writeFile(
			join(dir, "env"),
			"FACTORY_SCRATCH_DIR=/work/scratch\nFACTORY_REPO_DIR=/work\nFACTORY_APP_DIR=/root\nFACTORY_RUN_AS=nobody\nFACTORY_PATH=/usr/local/bin:/usr/bin:/bin\n",
			{ mode: 0o600 },
		);
		const files: string[] = [];

		for (const [key, value] of [...input.targets.map((t) => [`session_${t.connector}`, t.session] as const), ["proxies", input.proxies] as const]) {
			if (value !== undefined) {
				await writeFile(join(dir, key), value, { mode: 0o600 });
				files.push("--file-local", `/secrets/${key}=${join(dir, key)}`);
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
			z
				.string()
				.regex(/^nr-tmp-[a-z0-9-]{1,55}$/)
				.parse(charged.name),
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
		await charged.update("started", machine);
		await host(["machine", "wait", machine, "--app", "nr-probe", "--state", "started", "--wait-timeout", "2m"]);
		for (const name of ["probe", "as-runner.sh", "env"])
			await host(["ssh", "sftp", "put", join(dir, name), `/root/${name}`, "--app", "nr-probe", "--machine", machine]);
		await host([
			"ssh",
			"console",
			"--app",
			"nr-probe",
			"--machine",
			machine,
			"-C",
			"sh -c 'command -v setpriv >/dev/null && command -v timeout >/dev/null && command -v unshare >/dev/null && mkdir -p /work/scratch /secrets && cp /root/probe /work/probe && chmod 555 /work/probe && chown -R 65534:65534 /secrets && chmod 700 /root && chmod 400 /root/as-runner.sh /root/env'",
		]);
		const results: Record<string, Awaited<ReturnType<typeof assertProbe>>> = {};
		for (const target of input.targets) {
			const by = target.trusted[0]?.by ?? target.control.known.By;
			results[target.connector] = await assertProbe(
				target.control,
				async (value, network) => {
					const request = {
						by,
						value,
						session: target.session === undefined ? "" : `/secrets/session_${target.connector}`,
						proxies: input.proxies === undefined ? "" : "/secrets/proxies",
					};
					await writeFile(join(dir, "exec.json"), JSON.stringify(request), { mode: 0o600 });
					await host(["ssh", "sftp", "put", join(dir, "exec.json"), "/root/exec.json", "--app", "nr-probe", "--machine", machine as string]);
					const started = performance.now();
					const output = await host([
						"ssh",
						"console",
						"--app",
						"nr-probe",
						"--machine",
						machine as string,
						"-C",
						`sh -c 'chmod 400 /root/exec.json && /usr/bin/env -i PATH=/usr/local/bin:/usr/bin:/bin /usr/bin/timeout --kill-after=5s 35 ${network ? "" : "/usr/bin/unshare --net "}/bin/bash /root/as-runner.sh /usr/bin/env NR_SIGNUP_BUILD_VERSION=${input.head} /work/probe lookup ${target.connector} </root/exec.json; code=$?; printf "\\nNRPROBE_STATUS %s\\n" "$code"'`,
					]);
					const match = /\nNRPROBE_STATUS (\d+)\s*$/.exec(output);
					if (match?.[1] !== "0") throw new Error("Candidate RPC has no successful runner exit");
					return { output: JSON.parse(output.slice(0, match.index)), elapsedMs: performance.now() - started };
				},
				target.trusted,
			);
		}
		const result = results;
		return { head: input.head, region: "iad", binary_sha256: createHash("sha256").update(binary).digest("hex"), result };
	} catch (error) {
		if (error instanceof FactoryFailure) throw error;
		throw new FactoryFailure("probe", "environment_failure", {
			status: "fail",
			head: input.head,
			region: "iad",
			stage: "build_dispatch_or_validation",
		});
	} finally {
		try {
			if (machine) {
				await terminateProbe(cleanupHost, machine);
				await charged?.update("terminated", machine);
			}
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	}
}
