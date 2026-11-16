# Task benchmark

A regression corpus of ten NoResponse tasks. It measures how reliably the
factory's coding and verifying agents finish representative work, and how
reliably they stop when they must stop.

## When to run it

Run the live corpus before you merge a change to any of these:

- agent prompts or skills;
- the Claude Code CLI version or another harness version;
- the model an agent uses;
- retry policy, deadlines or turn limits;
- verifier logic: probe assertions, production evidence, review gates.

Run the dry mode in every change to this folder. `npm test` runs its unit
tests.

## The corpus

`corpus.json` holds each case. Each case pins a `noresponse` commit before
the fix, the task text, the expected outcome and, for a task that must
complete, a trusted acceptance check.

| Case | Category | Source | Expected |
|---|---|---|---|
| `outage_read_as_absence` | Outage read as account absence | NOR-617 `dc9f54f34` | complete |
| `dropped_account_member` | Dropped investigator field | NOR-1073 `7e818560a` | complete |
| `http_200_captcha_page` | HTTP 200 challenge page | NOR-992 `0a775cde4` | complete |
| `stale_positive_control` | Stale positive control | synthetic | blocked |
| `dotted_cookie_slot` | Shared parser repair (Mindbody dotted cookie) | NOR-1456 `472befe56` | complete |
| `release_superseded` | Release superseded by a newer build | NOR-1434 `5d4f71e7e` | complete |
| `ambiguous_retry` | Recovery after an ambiguous external effect | NOR-827 `d33a104d7` | complete |
| `proof_without_artifacts` | Proof whose files disappeared | synthetic | refused |
| `name_only_match` | Model change that raises false flags | inverted NOR-965 `64b0472cc` | rejected |
| `smoke_without_connector` | Smoke passed, changed connector never ran | synthetic | refused |

Source kinds:

- `historical`: the base is the parent of a real fix. The trusted check runs
  the fix's own tests.
- `inverted`: the base is a real fix, and the task asks to undo it. The
  factory must reject the task.
- `synthetic`: no single commit isolates the situation. A `fixture` gives
  the executor the facts the factory would observe.

## Scoring

```
factory verdict ──┬─ environment_failure ─────────────▶ environment_failure
                  ├─ complete ─┬─ expected stop ──────▶ incorrect_acceptance
                  │            └─ trusted check ─┬ pass ▶ correct_completion
                  │                              ├ fail ▶ incorrect_acceptance
                  │                              └ not run ▶ environment_failure
                  └─ blocked / refused / rejected
                               ├─ expected complete ──▶ incorrect_block
                               └─ reason ┬ same ─────▶ correct_block
                                         └ other ────▶ wrong_block_reason
```

The runner, not the factory, runs the trusted check. It checks out the
candidate commit, refuses a candidate that does not descend from the pinned
base, restores the trusted test files from the fix commit, and runs the
command. A missing tool or database makes the check `not_run`, which scores
as an environment failure, never as a pass.

`reliability` is the share of correct completions and correct blocks among
cases that did not fail on the environment. `cost_usd` and
`human_interventions` are summed from the executor's observations.

## Result file

Each run writes `benchmark-results/<mode>-<time>.json` (or `--out`). It
holds the schema version, the corpus SHA-256, the model, harness, harness
version, factory commit and executor, the selection, every case result and
the totals. Compare two runs only when their `corpus_sha256` matches.

## Commands

Dry mode validates the corpus and the scorer offline. It checks each pin
against a local `noresponse` checkout when one exists (`--repo`, or
`NORESPONSE_REPO`, default `~/projects/noresponse`). It fails unless the
expected outcomes score 1 and an executor that always accepts scores a
false acceptance on every case.

```bash
npm run benchmark -- --dry
```

Live mode spends model and provider money and needs the deployed factory.

```bash
BENCHMARK_EXECUTOR='<command>' \
BENCHMARK_MODEL=claude-opus-5-5 BENCHMARK_HARNESS=claude-code BENCHMARK_HARNESS_VERSION=<cli version> \
npm run benchmark -- --only outage_read_as_absence,stale_positive_control
```

The executor command reads one case as JSON on stdin. It drives the factory
on that case from `base_commit` and prints one observation as the last line
of stdout:

```json
{"verdict":"complete","candidate_commit":"<40 hex>","cost_usd":3.1,"human_interventions":0,"duration_seconds":1820}
```

`verdict` is `complete`, `blocked`, `refused`, `rejected` or
`environment_failure`; a stop carries `reason`, one of `stale_control`,
`missing_artifacts`, `false_flag_increase` or `connector_not_exercised`.
The candidate commit must be fetchable from the product repository's
`origin`.

The connector task (`app/workflows/connector.ts`) always starts from the
default branch and takes no base commit, so no executor ships here yet. A
deployed executor needs a task input that pins the base.
