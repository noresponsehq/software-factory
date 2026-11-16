# Connector factory setup

This fork runs the NoResponse connector lifecycle with Claude Code on a Claude
subscription. It does not need a model API key. Ordinary setup and production
delivery have user authorization within the shared US$50 UTC-day cap. Preserve
that cap during setup, before the runtime reservation exists. No paid lifecycle
runs are permitted while independent supervisor review or billing admission is
unresolved.

## Credentials and prerequisites

Work in the existing factory checkout. Local credentials come only from
`/Users/harryjohnston/projects/noresponse/.env`; environment variables take
precedence. Do not create a `.env` in the factory fork. Never print credentials.
The `--credential-file` option of `setup:app` and `setup:render` accepts an
absolute main credential-file path and defaults to the path above. It selects
the output file; the npm commands load the default main file. For another main
checkout, run Node with its explicit `--env-file` and the same option.

Use Node from `.node-version`, run `npm ci`, then `npm run setup:preflight --
--local`. The configured repository is `noresponsehq/noresponse`; verify the
base branch, connector marker and verification commands in `factory.config.ts`.
Use the main NoResponse checkout's `make doctor` before operating its services.

Required host values are documented by `.env.example` and `SERVICE_ENV` in
`scripts/lib/requirements.ts`. They include GitHub App credentials, Render API
and workspace, Claude subscription token, ledger operator token and URL, Linear,
Fly, production search key, installation ID, actor, Linear assignee and team.
`CLAUDE_CODE_OAUTH_TOKEN` is separate from the ledger run token. Guests can read
both of these scoped credentials; broad production credentials stay on the host.
There is no API-key fallback. Confirm local `claude auth status --json` reports
subscription authentication without printing credential values.

## GitHub App and Render configuration

Reuse an existing correctly scoped App when available. Otherwise run
`npm run setup:app -- --org noresponsehq`. Complete GitHub's manifest flow and
install the App on the configured repository. The command writes only its three
new values to the main credential file. Run `npm run setup:preflight` before
`npm run setup:render`. The latter creates or updates the existing environment
groups, and `--workspace` writes its value to the same main credential file.

The gateway receives only webhook and Render task-dispatch credentials.
The workflows group receives GitHub, Claude subscription, ledger operator,
Linear, Fly and production search credentials. Neither process may log them.
Deploy the Blueprint only after baseline compute, retained snapshot storage and
all provider traffic have enforceable allowances within the shared cap. An IP
byte counter alone does not establish a whole-invoice upper bound.

Run `npm run setup:github -- --gateway-url https://<gateway>.onrender.com` to
set the webhook and configured connector label. Verify webhook delivery to that
URL. Run gateway doctor in its service environment and workflows doctor with the
deployed values. Doctor checks configuration, GitHub access, registered tasks,
ledger operator cursor, Linear authentication and Fly probe machine access.
Presence of the subscription token is not proof of a successful Claude run.

## Workstation image

`sandbox/install-connector-tools.sh` installs pinned Claude Code, Go, Python,
uv, Node, git, Chromium and APK inspection tools. Image builds need a separate
recorded compute and storage reservation before creation. Runtime connector
work refuses a missing snapshot instead of creating one outside its allowance.
Do not run upstream refresh tasks outside this reservation. Do not resume a
suspended sandbox without a new reservation. Use explicit 2c-4g, idle timeout
zero, an absolute host deadline and verified termination.

Every candidate process, install and check must use the reviewed network
supervisor, including the Fly probe. The adapter refuses an unreviewed helper
hash. Local Chromium remains disabled until its relevant traffic and tariff
are proved bounded. Fly's prepared image must include Python 3 and the kernel
features the same supervisor needs; a missing prerequisite is a failure.

## Intake and lifecycle smoke

`npm run intake` dispatches assigned Linear issues, marked GitHub issues, D1
health events and expired unfinished runs. Assign an actual connector outcome
with `<!-- connector:github -->` or the selected connector ID. GitHub uses the
configured `factory:connector` label. Include the linked `NOR-...` issue.
Intake creates a deterministic Linear issue when no outcome already exists.
Schedule intake only after its baseline compute is budgeted.

The ledger owns `FACTORY_DAILY_USD` (default 50) and `FACTORY_CONCURRENCY`
(default 4, range 1..64). The factory has no second concurrency limit. The host
must see the deployed recovery, resource journal, durable cursor and evidence
protocol before starting. An active replay has no token and performs no work;
expired recovery uses the fenced recovery operation before cleanup or execution.
A held run permits cleanup only and must not launch another guest.

The reserved smoke must exercise actual subscription authentication,
implementation, a fresh independent verifier, trusted main probe harness plus
connector overlay, Fly iad probe, ready PR, expected-head auto-merge, CI/review
repair, release plan correlation and production search. Failed receipts must
survive. The Linear issue remains open until production evidence passes with
positive checks, no failures or skips, and the deployed merge SHA.

Report setup as partial until both doctors and this smoke pass. Record source,
selection, provider resources, conservative charges, outcomes and termination.
Do not describe fake-service unit tests as live proof. Use `npm run check` for
local lint, types and boundary regressions before requesting independent review.
