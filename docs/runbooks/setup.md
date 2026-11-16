# Connector factory setup

This fork runs the NoResponse connector lifecycle with Claude Code on a Claude
subscription. It does not need a model API key. Ordinary setup and production
delivery have user authorization under a shared US$50 UTC-day admission budget. Conservative reservations include
compute ceilings and estimated traffic, baseline and storage costs. The user
accepts possible provider billing overruns. No live factory execution is permitted
until independent review accepts this integration.

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

The gateway receives webhook, Render task-dispatch and ledger operator
credentials for daily admission. It receives no GitHub or model credential.
The workflows group receives GitHub, Claude subscription, ledger operator,
Linear, Fly and production search credentials. Neither process may log them.
The setup command admits the daily baseline, retained storage and dispatch
estimates through D1 before deployment. Gateway and intake repeat this idempotent
admission each UTC day. An exhausted allowance refuses new factory dispatch;
existing provider services can still bill. This is not an invoice guarantee.

Run `npm run setup:github -- --gateway-url https://<gateway>.onrender.com` to
set the webhook and configured connector label. Verify webhook delivery to that
URL. Run gateway doctor in its service environment and workflows doctor with the
deployed values. Doctor checks configuration, GitHub access, registered tasks,
ledger operator cursor, Linear authentication and Fly probe machine access.
Presence of the subscription token is not proof of a successful Claude run.

`npm run doctor -- --live [--revision <sha>]` checks reality against the intended
revision (default: this checkout's HEAD). It fails, naming each mismatch, when the
`factory-workflows` Workflow's newest ready version is another commit, when any
task is not registered on that version, when `factory-gateway` or
`factory-intake` has no live deploy of that commit, or when the `doctor` task,
run inside the deployed Workflow, cannot create and terminate a sandbox or reach
the ledger Worker, GitHub or the noresponse API. A suspended service is a warning.

Without the Blueprint, create the services from the branch with auto-deploy off:
`render workflows create --name factory-workflows --branch <branch> ...` with the
build and start commands in `render.yaml`, then link `software-factory-shared`
and `software-factory-workflows` with `POST /v1/env-groups/{id}/services/{id}`
and run `render workflows versions release <id> --commit <sha> --wait`. Create
`factory-gateway` and `factory-intake` with `POST /v1/services` on the starter
plan, set `RENDER_WORKFLOW_SLUG` to the Workflow's slug, link their groups, and
deploy the same commit.

The workflows build installs Fly CLI 0.5.10, uv 0.12.2 and Go 1.27.4 under
`.factory-tools`, checking pinned archive hashes. Its start command checks these
binaries and git, jq, Node, npm, curl and Python before registering tasks. The
production search builds the SDK generator at the trusted operator checkout's
`generator.lock` revision. The App must also be installed on
`noresponsehq/noresponse-openapi-generation` with contents read access. Its
repository-scoped fetch token is removed before building or running that source.

## Workstation image

`sandbox/install-connector-tools.sh` installs pinned Claude Code, Go, Python,
uv, Node, git, Chromium and APK inspection tools. Run `npm run setup:snapshot -- --repo noresponsehq/noresponse` after setup and review.
The command reserves builder compute and traffic before creation; the daily
allowance includes retained snapshot storage. Runtime connector
work refuses a missing snapshot instead of creating one outside its allowance.
Do not run upstream refresh tasks outside this reservation. Do not resume a
suspended sandbox without a new reservation. Use explicit 2c-4g, idle timeout
zero, an absolute host deadline and verified termination.

Every candidate process, install and check uses the trusted launcher, which
starts with a fixed clean root environment and uses `setpriv` to drop groups,
UID/GID and all capabilities with no-new-privs. Candidate variables are applied
only after the drop. Extra descriptors are closed. The Fly probe uses the same
launcher. Render builders/restores use `allow-all`, and local Chromium can reach
any domain. No custom kernel supervisor is used. Fly's prepared image must supply
`setpriv`, `timeout` and `unshare`; a missing prerequisite fails closed.

## Intake and lifecycle smoke

`npm run intake` dispatches assigned Linear issues, marked GitHub issues, D1
health events and expired unfinished runs. Assign an actual connector outcome
with `<!-- connector:github -->` or the selected connector ID. GitHub uses the
configured `factory:connector` label. Include the linked `NOR-...` issue.
Intake creates a deterministic Linear issue when no outcome already exists.
The Blueprint schedules `factory-intake` every five minutes UTC with a
180-second command deadline. Intake admits the daily dispatch estimate before
starting tasks; it uses the dedicated intake environment group.

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

Factory Fly probes use `FACTORY_FLY_API_TOKEN`, scoped to `nr-probe`. The host
passes it to the Fly child process as `FLY_API_TOKEN`; it never overwrites the
main checkout's generic Fly credentials. Production `version,search` smoke
receives only its search key and needs no Fly credential.

When available, `NR_PROD_WORKER_LOGS_TOKEN` supplies production worker log
attribution. Setup copies this optional secret to the workflows group without
requiring it. Missing attribution leaves actual search gaps visible and cannot
be replaced by the probe token or generic CLI authentication.
