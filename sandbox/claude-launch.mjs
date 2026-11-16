import { readFileSync, rmSync, mkdirSync, chownSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";

const dir = process.argv[2];
const input = JSON.parse(readFileSync(`${dir}/input.json`, "utf8"));
rmSync(`${dir}/input.json`);
const home = `${dir}/home`;
mkdirSync(home, { mode: 0o700 });
const uid = Number(spawnSync("id", ["-u", "factory"], { encoding: "utf8" }).stdout.trim());
const gid = Number(spawnSync("id", ["-g", "factory"], { encoding: "utf8" }).stdout.trim());
if (!uid || !gid) process.exit(1);
chownSync(dir, uid, gid);
chownSync(home, uid, gid);
writeFileSync(`${home}/settings.json`, JSON.stringify({ forceLoginMethod: "claudeai", disableAllHooks: true }), { mode: 0o444 });
const env = {
	PATH: "/usr/local/bin:/usr/bin:/bin", HOME: home, CLAUDE_CONFIG_DIR: home,
	CLAUDE_CODE_OAUTH_TOKEN: input.subscriptionToken,
	NR_FACTORY_RUN_TOKEN: input.runToken, NR_FACTORY_LEDGER_URL: input.ledgerUrl,
	DISABLE_AUTOUPDATER: "1", CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
};
const common = { cwd: "/opt/factory/repo", uid, gid, env, encoding: "utf8", timeout: input.seconds * 1000, maxBuffer: 4 * 1024 * 1024 };
const restricted = ["--no-new-privs", "--bounding-set=-all", "--inh-caps=-all", "--ambient-caps=-all", "claude"];
const auth = spawnSync("setpriv", [...restricted, "auth", "status", "--json"], common);
let status;
try { status = JSON.parse(auth.stdout); } catch { process.exit(1); }
if (auth.status !== 0 || !status.loggedIn || !["claude.ai", "oauth_token"].includes(status.authMethod)) process.exit(1);
const run = spawnSync("setpriv", [...restricted, "-p", "--output-format", "json", "--json-schema", JSON.stringify(input.schema),
	"--permission-mode", "bypassPermissions", "--strict-mcp-config", "--mcp-config", '{"mcpServers":{}}',
	"--setting-sources", "", "--settings", `${home}/settings.json`, "--no-session-persistence", "--max-turns", "100"], { ...common, input: input.prompt });
if (run.status !== 0) process.exit(1);
process.stdout.write(run.stdout);
