# Autonomous connector workflow

The NoResponse deployment uses `factory.config.ts.connectors`. The upstream
example workflows remain available to other configurations. Connector mode
ignores their GitHub triggers and setup requires a Claude subscription token,
not an Anthropic API key. No fallback provider is configured.

```
GitHub marker / assigned Linear / D1 health
  │
  ├─ D1 claim: condition, lease, shared budget, needs_person
  ├─ Claude Code implementation in Render
  ├─ host validates and publishes candidate tree
  ├─ fresh Claude Code verification in another Render sandbox
  ├─ third sandbox pins main controls and builds lookup RPC
  ├─ trusted host runs the probe on Fly iad
  ├─ ready PR → expected-head auto-merge → CI repairs
  └─ release SHA + production search → Linear completion
```

The host owns repositories, branches, GitHub writes, Linear transitions and
provider credentials. Guests receive a separate Claude subscription token and
connector-scoped ledger run token. Both credentials are readable by guest code;
they are not a credential-free execution environment. The trusted launcher clears
ambient environment and drops UID, groups and capabilities. Authentication must
report `claude.ai` or `oauth_token`; a refused or expired subscription fails.

## Configuration and setup

Local credentials are read only from
`/Users/harryjohnston/projects/noresponse/.env`, with existing environment values
winning. Do not create another credentials file in this fork. `.env.example`
documents names. `SERVICE_ENV` and `ENV_GROUPS` own deployment requirements.

Set `FACTORY_GITHUB_INSTALLATION_ID`, `FACTORY_ACTOR`,
`FACTORY_LINEAR_ASSIGNEE` and `FACTORY_LINEAR_TEAM` to the authorized installation,
GitHub actor and Linear UUIDs. The actor's current write permission is checked
before every connector run. The configured repository is
`noresponsehq/noresponse`; the marker defaults to `factory:connector`.

A GitHub issue body uses `<!-- connector:github -->` and a linked `NOR-...` issue.
Assigned Linear issues use the same connector marker. The host intake command
also reads ledger health changes and creates a deterministic Linear outcome when
none exists. Existing unfinished runs are read from D1 for CI/release continuation.
The intake command is `node --import tsx scripts/connector-intake.ts`; run it with
the configured host environment. The Blueprint schedules intake every five minutes UTC with a 180-second
command deadline, under the daily dispatch allowance. GitHub push webhooks do not refresh snapshots in
connector mode.

Run `npm run setup:preflight`, `npm run setup:render`, `npm run doctor` using the
existing setup runbook. Connector snapshots need the pinned Claude CLI, Go,
Python, uv, Node, git, Chromium and APK inspection tools installed by
`sandbox/install-connector-tools.sh`. Run `npm run setup:snapshot -- --repo noresponsehq/noresponse` to build the image
under a separate journalled setup reservation. Connector tasks refuse to build a missing snapshot inline.
Render SDK 1.8 exposes the current `render.sandboxes` client and explicit plans.

## Durable execution and cost

`app/connectors/ledger.ts` implements the Accounts Worker's factory contract.
Every phase transition is a versioned compare-and-set. Periodic renewal is
serialized with evidence and resource writes. Loss of ownership stops tracked
sandboxes. Expired claims rotate their guest token; the host retains the new one.
Active replays omit the token and cannot own work. Expired recovery uses a server
CAS before effects. Held runs carry `cleanup_only` and only terminate journalled
resources and finish blocked. The shared health cursor advances only after durable
dispatch, including filtered pages with no failing events. Blockers remain in D1 until their condition changes, and needs_person is never
a prompt to keep retrying.

The shared cap defaults to US$50 per UTC day in the ledger. `tool_allowance_usd`
is inside the reservation. Before a resource is created, the host writes its
immutable ceiling into `resource_charges`. Ambiguous creates remain charged.
Resource states only advance from reserved to started to terminated. Render
uses explicit 2c-4g, one-hour lifetime and idle suspension disabled. Provider
cleanup runs even after a failed stage. The full reserved compute ceiling is
charged as `reserved_upper_bound`, never called measured usage. Ledger-paid
checks are charged by the ledger exactly once and excluded from host charges.

The Render bound is US$0.316/hour for a fully busy 2c-4g sandbox; workflow flex
uses US$0.40/hour at its maximum CPU/RAM. Fly shared-cpu-4x plus 4 GiB in iad
uses a conservative US$0.038/hour compute bound. These are compute ceilings,
not whole-invoice promises. Network transfer, retained snapshots and gateway
baseline use conservative estimates in the same admission budget. The user
accepts possible provider billing overruns. Connector builders and restores use
Render `allow-all`; local Chromium has unrestricted networking. No custom
network supervisor or byte-quota helper is installed or executed.

## Evidence and verification

Evidence is uploaded to D1 with run, candidate/merge SHA, kind and SHA-256 digest.
Only bounded counts, selections, statuses and artifact references are sent.
Credentials, control identifiers and raw provider output are excluded. Failed
checks retain receipts. Ledger production evidence must contain `status:pass`,
positive checks, zero failed and zero skipped.

The Fly adapter runs fixed host commands, never a script from the candidate on
the host. Only the candidate lookup binary and host-selected connector
session/proxy files reach the machine. The candidate only returns lookup readings. Host-owned assertions compare them
with controls exported from trusted main before any candidate code runs. An AST
pin rejects changes to Known declarations and referenced constants. The host
checks required fields, five positive/absent trials, end-to-end latency and a
separate network namespace failure control. Guest pass/verdict JSON is rejected.
Trusted main tests and independent Claude review remain additional gates.
New connectors and supplied controls without a trusted approval source are
blocked, a partial capability tracked by [NOR-1489](https://linear.app/noresponse/issue/NOR-1489/supply-approved-controls-to-autonomous-connector-probes).

Production verification independently resolves and fetches the complete default
branch revision. This pins the operator script, helpers, regression suite and
SDK generator together. The read-only clone credential is removed before any
repository code executes. The trusted runbook command selects `version,search`
with the five-identity sample; it is not exhaustive provider coverage. Both
version reads and the search summary must identify the merged release SHA.
A partial search, rollback or missing evidence cannot close Linear.

`npm run check` runs lint, TypeScript and the fake-service boundary suite. Live
Claude subscription, sandbox image installation, unrestricted networking, Fly
probing and complete deployment are separate checks and must be reported as
unverified until exercised. Local passing tests do not claim those results.

The daily service allowance is admitted before gateway dispatch, intake or image
setup: US$1 baseline, US$0.50 retained storage and US$1 dispatch overhead. A
stable UTC-day/policy key prevents duplicate charges. These estimates cover
otherwise unclaimed dispatch and service work, cron runtime and its $1 monthly
minimum, plus estimated service/cron build costs; they are not provider ceilings.
Each Render attempt adds US$0.20 estimated traffic to its compute reservation;
each Fly probe does the same. `connectors.costs` configures these estimates.
Increasing a policy mid-day admits a new full allowance. Reduce future estimates
only after comparing provider charges; changing policy never refunds prior costs.
The host records maintenance allowances as blocked terminal runs with an explicit
accounting reason because completed runs require production proof. This does not
claim a connector outcome. Intake excludes those maintenance runs.

A connector reserves US$8 including US$0.50 ledger tools. An implementation task
reserves four hours of workflow compute; CI/release continuations reserve twenty
minutes with matching host/provider deadlines. Snapshot setup reserves one hour
of builder and host compute plus estimated traffic; storage is included in the
daily allowance. Interrupted ambiguous creations retain their full reservation.
The launcher uses standard `setpriv` with a clean root environment, closed extra
descriptors, empty capabilities and no-new-privs before candidate environment is
applied. Provider VM isolation and termination deadlines remain in place.

The revised ordinary integration must pass independent review before live factory
execution. The complete live lifecycle remains unverified by local tests.

Factory Fly probes use `FACTORY_FLY_API_TOKEN`, scoped to `nr-probe`. The host
passes it to the Fly child process as `FLY_API_TOKEN`; it never overwrites the
main checkout's generic Fly credentials. Production `version,search` smoke
receives only its search key and needs no Fly credential.

When available, `NR_PROD_WORKER_LOGS_TOKEN` supplies production worker log
attribution. Setup copies this optional secret to the workflows group without
requiring it. Missing attribution leaves actual search gaps visible and cannot
be replaced by the probe token or generic CLI authentication.

The intake group holds only Render dispatch, ledger operator, Linear and GitHub
App credentials plus actor, installation, team and assignee settings. It receives
no Claude subscription, Fly or production search/log secret. Intake starts tasks;
it never executes candidates or calls a model.
