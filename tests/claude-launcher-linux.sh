#!/usr/bin/env bash
set -euo pipefail
[ "$(uname -s)" = Linux ] && [ "$(id -u)" = 0 ]
launcher=${1:-sandbox/claude-launch.mjs}
[ ! -e /usr/local/bin/claude ] || { echo 'Use a disposable Linux host without Claude installed' >&2; exit 1; }
id factory >/dev/null 2>&1 || useradd --system --user-group --no-create-home factory
mkdir -p /opt/factory/repo
stage=$(mktemp -d /tmp/nr-tmp-claude-launch.XXXXXX)
trap 'rm -rf "$stage"; rm -f /usr/local/bin/claude' EXIT
install -m 600 "$launcher" "$stage/launch.mjs"
cat > /usr/local/bin/claude <<'JS'
#!/usr/bin/env node
const fs = require('node:fs');
const assert = require('node:assert/strict');
assert.notEqual(process.getuid(), 0);
const status = fs.readFileSync('/proc/self/status', 'utf8');
assert.match(status, /^NoNewPrivs:\s+1$/m);
assert.match(status, /^CapEff:\s+0+$/m);
assert.equal(process.env.ANTHROPIC_API_KEY, undefined);
assert.equal(fs.existsSync(require('node:path').join(process.env.HOME, '../input.json')), false);
if (process.argv.includes('auth')) console.log(JSON.stringify({loggedIn:true,authMethod:'oauth_token'}));
else console.log(JSON.stringify({is_error:false,structured_output:{status:'verified',summary:'CLI stand-in only',evidence:[]}}));
JS
chmod 755 /usr/local/bin/claude
printf '%s' '{"seconds":10,"subscriptionToken":"offline-test","runToken":"offline-test","ledgerUrl":"https://ledger.invalid","prompt":"offline","model":"claude-opus-5-5","schema":{}}' > "$stage/input.json"
env -i PATH=/usr/local/bin:/usr/bin:/bin node "$stage/launch.mjs" "$stage" > "$stage/result.json"
node - "$stage" <<'JS'
const fs = require('node:fs');
const assert = require('node:assert/strict');
const dir = process.argv[2];
const result = JSON.parse(fs.readFileSync(dir+'/result.json', 'utf8'));
assert.equal(result.is_error, false);
assert.equal(result.structured_output.summary, 'CLI stand-in only');
const stat = fs.statSync(dir+'/launch.mjs');
assert.equal(stat.uid, 0);
assert.equal(stat.mode & 0o777, 0o444);
assert.equal(fs.existsSync(dir+'/input.json'), false);
JS
echo 'PASS root-owned mode-0600 upload executes after privilege drop; CLI stand-in only'
