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
  ├─ fourth sandbox runs regression tests on untouched main
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

Trusted controls come from the connector ledger: the host reads
`GET /ledger/controls/{connector}` with its operator bearer, which no guest
holds. A control states the identifier, the variant (present, absent, private,
suspended, renamed, regional), the subject the account must answer with, typed
expected values, its provenance and its freshness. When the ledger holds
controls for a connector they replace its declared ones, so new connectors and
supplied email and phone controls can be probed. The host fails a reading whose
subject differs (`subject_mismatch`) or whose value differs (`value_mismatch`),
and blocks before any lookup on a control past its freshness (`stale_control`),
one not written by the operator (`untrusted_control`), or a connector with
neither ledger controls nor a pinned declaration (`missing_trusted_control`).
Probe evidence pins each control's ledger revision and never its values.

A change outside one connector folder takes the shared recipe. Go packages
under `apps/identity/internal/` may change, except `internal/connector`, which
holds the control assertions, and the probe harness. The host overlays every
changed package, lists dependencies with `go list` (which runs no candidate
code) and probes every connector whose package depends on a changed one, each
against its own controls. A change that reaches more than 25 connectors blocks.

Production verification independently resolves and fetches the complete default
branch revision. This pins the operator script, helpers, regression suite and
SDK generator together. The read-only clone credential is removed before any
repository code executes. The trusted runbook command selects `version,search`
with the five-identity sample; it is not exhaustive provider coverage. Both
version reads and the search summary must identify the release under proof.
A partial search, rollback or missing evidence cannot close Linear.

That smoke does not prove the task's connector. Each candidate commits an
acceptance recipe at `apps/identity/internal/connectors/<id>/acceptance.json`
(`app/connectors/acceptance.ts`): the behaviour changed, fixtures, required
session and route, the public operation, the expected execution and fields,
the ledger revision followers must report, and uncovered conditions.
Production reads the recipe from the merge commit, polls the API and worker
`/healthz` until both report that ledger revision, adds the fixture as a
person through the public API, and passes only when the person's
`lookup.records` hold a record from that connector with every expected field
and no lookup check lists the connector as unanswered. Each failure is typed
(`connector_not_executed`, `ledger_revision_not_observed`, `stale_build` and
so on). Only public handle fixtures can be carried in a recipe; sealed email
and phone controls answer `fixture_unresolved` until a resolver exists.

When a later merge B that contains A is released instead of A, or production
moves from A to B during proof, the receipt records `release_state:
superseded` with the requested and observed SHAs, and the whole proof runs
again against B. Ancestry alone never passes. A build that does not contain A
is refused as `stale_build`.

### Verification bundle

Each candidate and production verification stores one typed bundle
(`app/connectors/bundle.ts`) as `verification` or `production` evidence. It names
the task and acceptance-recipe digests; the candidate, trusted base and observed
release SHAs; fixture and session-generation digests; the exact selection and
reproduction commands; expected-versus-observed assertions; the paired negative
control; artifact references with SHA-256; the model and harness identity
(model, Claude Code version, launcher, prompt and skill digests); uncovered
conditions; and a failure class: `missing_prerequisite`, `product_failure`,
`stale_control`, `superseded_release` or `environment_failure`.

Artifacts go to the same evidence route before any temporary directory is
deleted, as UTF-8 chunks of at most 12,000 characters, each bound to the file's
SHA-256. A binary file, a file over 64 chunks, or a chunk the ledger refuses as
sensitive keeps only its digest and is listed as uncovered. A ledger outage
fails the run.

The verifier names its negative control as connector test files and a
`go test -run` pattern. The host copies those files into a separate, untouched
checkout of the trusted base as readable runner files. Structured Go output must
show the same named tests failing on that base and passing on the candidate.
Build failures, skipped tests, empty selections and permission errors cannot
serve as negative evidence. Both logs are retained, including refused runs. The
host, not the agent summary, refuses a review or production proof whose bundle
is missing, malformed, for another revision, failing, without passing
assertions or uploaded artifacts, or, for a candidate, without a valid negative
control and harness identity. The ledger client keeps known `cleanup_only`,
`resource_charges` and `evidence_ids` when a heartbeat or evidence response
omits them, and refuses a claim that omits them.

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
