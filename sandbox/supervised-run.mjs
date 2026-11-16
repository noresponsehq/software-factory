import { spawnSync } from "node:child_process";

const [cwd, uid, gid, ...args] = process.argv.slice(2);
const split = args.indexOf("--");
if (process.getuid() !== 0 || split < 0) process.exit(1);
const env = Object.fromEntries(args.slice(0, split).map((entry) => {
	const pos = entry.indexOf("=");
	if (pos < 1) throw new Error("Invalid explicit environment");
	return [entry.slice(0, pos), entry.slice(pos + 1)];
}));
const run = spawnSync("/usr/bin/python3", ["-I", "/opt/factory/app/network-supervisor.py", "exec"], {
	input: JSON.stringify({ argv: args.slice(split + 1), env, cwd, uid: Number(uid), gid: Number(gid), seconds: 3600 }),
	encoding: "utf8", maxBuffer: 9 * 1024 * 1024, timeout: 3610000,
	env: { PATH: "/usr/local/bin:/usr/bin:/bin" },
});
if (run.stdout) process.stdout.write(run.stdout);
if (run.stderr) process.stderr.write(run.stderr);
process.exit(run.status ?? 1);
