import { readFileSync, rmSync, mkdirSync, chownSync, chmodSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";

const rootEnv = { PATH: "/usr/local/bin:/usr/bin:/bin", LANG: "C.UTF-8" };
if (process.argv[2] === "--child") {
	if (!process.getuid()) process.exit(1);
	const input = JSON.parse(readFileSync(0, "utf8"));
	const home = process.argv[3];
	const env = {
		...rootEnv, HOME: home, CLAUDE_CONFIG_DIR: home,
		CLAUDE_CODE_OAUTH_TOKEN: input.subscriptionToken,
		NR_FACTORY_RUN_TOKEN: input.runToken, NR_FACTORY_LEDGER_URL: input.ledgerUrl,
		DISABLE_AUTOUPDATER: "1", CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
	};
	const opts = { cwd: "/opt/factory/repo", env, encoding: "utf8", timeout: input.seconds * 1000, killSignal: "SIGKILL", maxBuffer: 8 * 1024 * 1024 };
	const auth = spawnSync("claude", ["auth", "status", "--json"], opts);
	let status;
	try { status = JSON.parse(auth.stdout); } catch { process.exit(1); }
	if (auth.status !== 0 || !status.loggedIn || !["claude.ai", "oauth_token"].includes(status.authMethod)) process.exit(1);
	if (typeof input.model !== "string" || !/^[a-z0-9.-]{1,100}$/.test(input.model)) process.exit(1);
	const run = spawnSync("claude", ["-p", "--model", input.model, "--output-format", "json", "--json-schema", JSON.stringify(input.schema),
		"--permission-mode", "bypassPermissions", "--strict-mcp-config", "--mcp-config", '{"mcpServers":{}}',
		"--setting-sources", "", "--settings", `${home}/settings.json`, "--no-session-persistence", "--max-turns", "100"], { ...opts, input: input.prompt });
	if (run.status !== 0) process.exit(1);
	process.stdout.write(run.stdout);
} else {
	if (process.getuid() !== 0) process.exit(1);
	const dir = process.argv[2];
	const input = JSON.parse(readFileSync(`${dir}/input.json`, "utf8"));
	rmSync(`${dir}/input.json`);
	chmodSync(process.argv[1], 0o444);
	if (!Number.isInteger(input.seconds) || input.seconds < 1 || input.seconds > 3600) process.exit(1);
	const home = `${dir}/home`;
	mkdirSync(home, { mode: 0o700 });
	const uid = Number(spawnSync("/usr/bin/id", ["-u", "factory"], { env: rootEnv, encoding: "utf8" }).stdout.trim());
	const gid = Number(spawnSync("/usr/bin/id", ["-g", "factory"], { env: rootEnv, encoding: "utf8" }).stdout.trim());
	if (!uid || !gid) process.exit(1);
	chownSync(dir, uid, gid);
	chownSync(home, uid, gid);
	writeFileSync(`${home}/settings.json`, JSON.stringify({ forceLoginMethod: "claudeai", disableAllHooks: true }), { mode: 0o444 });
	const run = spawnSync("/usr/bin/timeout", ["--kill-after=5s", String(input.seconds), "/usr/bin/setpriv",
		`--reuid=${uid}`, `--regid=${gid}`, "--clear-groups", "--no-new-privs", "--bounding-set=-all", "--inh-caps=-all", "--ambient-caps=-all",
		"--", process.execPath, process.argv[1], "--child", home], {
		env: rootEnv, input: JSON.stringify(input), encoding: "utf8", timeout: (input.seconds + 10) * 1000,
		killSignal: "SIGKILL", maxBuffer: 9 * 1024 * 1024, stdio: ["pipe", "pipe", "pipe"],
	});
	if (run.status !== 0) process.exit(1);
	process.stdout.write(run.stdout);
}
