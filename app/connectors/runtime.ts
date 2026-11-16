import { randomUUID } from "node:crypto";
import { z } from "zod";
import { publish } from "../changeset/index.js";
import { config, requireEnv, requireRepo } from "../config/index.js";
import { sanitizeInline } from "../format/index.js";
import { githubFor } from "../github/index.js";
import { type OpenedSandbox, openSandbox, sandboxClient, withSandbox } from "../sandbox/index.js";
import { runVerify } from "../workflows/run-verify.js";
import { accountDaily, costPolicy } from "./accounting.js";
import { Budget, upperBound } from "./budget.js";
import { type Assertion, bundleRefusal, sha256, uploadArtifacts, type VerificationBundle } from "./bundle.js";
import { runClaude } from "./claude.js";
import { FactoryBlocked, FactoryFailure } from "./failure.js";
import { Lease } from "./lease.js";
import { ClaimInput, Ledger } from "./ledger.js";
import { advance } from "./lifecycle.js";
import { pairedNegativeControl } from "./negative-control.js";
import { Linear } from "./linear.js";
import { flyExec, probe, terminateProbe } from "./probe.js";
import { AcceptanceRecipe, recipePath } from "./acceptance.js";
import { productionVerify } from "./production.js";
import { released } from "./release.js";
import { resolveReviewedThreads, reviewThreads } from "./reviews.js";
import { trustedBuild } from "./trusted-build.js";

export const ConnectorInput = ClaimInput.extend({
	repo: z.string().min(1),
	installation_id: z.number().int().positive(),
	actor: z.string().min(1),
	task: z.string().min(1).max(50000),
});

export async function runConnector(raw: unknown, executionSeconds = 14400) {
	const input = ConnectorInput.parse(raw);
	const connectors = config.connectors;
	if (!connectors) throw new Error("Connector automation is not configured");
	if (input.reserve_usd !== connectors.reserveUsd || input.tool_allowance_usd !== connectors.toolAllowanceUsd)
		throw new Error("Run budget differs from host policy");
	const repo = requireRepo(input.repo, input.installation_id);
	if (!repo.config.verify.length) throw new Error("Connector workflow needs nonempty verification commands");
	const gh = githubFor(repo);
	if (!["write", "maintain", "admin"].includes(await gh.getPermission(input.actor))) throw new Error("Connector actor lacks write permission");
	const ledger = new Ledger(requireEnv("NR_LEDGER_URL"), requireEnv("NR_FACTORY_OPERATOR_TOKEN"));
	const { repo: _repo, installation_id: _installation, actor: _actor, task: _task, ...claimInput } = input;
	const claimed = await ledger.claim(claimInput);
	if (claimed.status !== "claimed") return claimed;
	const claim = await ledger.own(claimed, input.lease_seconds);
	if (!claim) return { status: "already_active", run_id: claimed.run_id };
	const branch = `${input.linear_issue}/factory-${claim.run_id}`;
	const lease = new Lease(ledger, claim, input.lease_seconds, executionSeconds);
	const checkpoint = (patch = {}) => lease.checkpoint(patch);
	const budget = new Budget(claim, lease);
	const cleanupPending = () =>
		claim.state.resource_charges.some((resource) => resource.kind !== "render_workflow_flex" && resource.status !== "terminated");
	const requireCleanup = () => {
		if (cleanupPending()) throw new Error("Provider cleanup is unconfirmed; retain unfinished run");
	};
	const finish = (outcome: "blocked" | "completed" | "failed", reason: string) =>
		lease.exclusive(() => {
			requireCleanup();
			return ledger.finish(claim, outcome, reason, budget.charged());
		});
	const open = async (name: string) => {
		const key = `render-${randomUUID()}`;
		const seconds = 3600;
		const update = await budget.reserve(key, "render_sandbox", upperBound(0.316, seconds) + costPolicy().sandboxTrafficUsd);
		const terminate = async (id: string) => {
			await sandboxClient().terminate(id);
			await sandboxClient().confirmTerminated(id);
		};
		const sandbox = await openSandbox(
			repo,
			{ kind: "branch", name },
			{
				resourceName: `nr-tmp-${key}`,
				timeoutSeconds: seconds,
				signal: lease.signal,
				onCreated: async (id) => {
					await lease.trackCleanup(() => terminate(id));
					await update("started", id);
				},
			},
		);
		sandbox.close = async () => {
			await terminate(sandbox.id);
			await update("terminated", sandbox.id);
		};
		return sandbox;
	};
	const evidence = (
		head: string,
		kind: "ci" | "probe" | "production" | "implementation" | "verification" | "release",
		payload: Record<string, unknown>,
	) => lease.exclusive(() => ledger.evidence(claim, head, kind, payload));
	lease.start();
	try {
		await checkpoint();
		let unresolved = false;
		for (const resource of claim.state.resource_charges) {
			if (resource.kind === "render_workflow_flex" || resource.status === "terminated") continue;
			if (!resource.resource_id) {
				unresolved = true;
				continue;
			}
			try {
				if (resource.kind === "render_sandbox") {
					await sandboxClient().terminate(resource.resource_id);
					await sandboxClient().confirmTerminated(resource.resource_id);
				} else if (resource.kind === "fly_probe") {
					await terminateProbe(flyExec(requireEnv("FACTORY_FLY_API_TOKEN")), resource.resource_id);
				} else {
					unresolved = true;
					continue;
				}
				await checkpoint({ resource_charges: [{ ...resource, status: "terminated" }] });
			} catch {
				unresolved = true;
			}
		}
		if (unresolved || lease.signal.aborted) return { status: "cleanup_pending", run_id: claim.run_id };
		if (claim.state.cleanup_only) {
			await finish("blocked", "Connector is held; owned resource cleanup completed");
			return { status: "blocked", run_id: claim.run_id, reason: "needs_person" };
		}
		await accountDaily(ledger);
		await budget.reserve(`workflow-${randomUUID()}`, "render_workflow_flex", upperBound(0.4, executionSeconds));
		const agent = (sandbox: OpenedSandbox, prompt: string) =>
			runClaude(sandbox, {
				prompt,
				subscriptionToken: requireEnv("CLAUDE_CODE_OAUTH_TOKEN"),
				runToken: claim.token,
				ledgerUrl: requireEnv("NR_LEDGER_URL"),
				seconds: Math.min(1800, input.lease_seconds - 60),
				model: connectors.model,
			});
		const taskSha256 = sha256(input.task);
		let lastSummary = "Connector lifecycle change";
		const result = await advance(
			claim,
			{
				checkpoint,
				implement: async (reason) =>
					withSandbox(
						() => open(claim.state.head_sha ? branch : repo.config.baseBranch),
						async (sandbox) => {
							await checkpoint();
							const feedback = claim.state.candidate_pr
								? JSON.stringify({
										reviews: await gh.listReviews(claim.state.candidate_pr),
										threads: await reviewThreads(gh.http, repo.owner, repo.name, claim.state.candidate_pr),
										checks: await gh.http.json("GET", `/repos/${repo.fullName}/commits/${claim.state.head_sha}/check-runs`),
									})
								: "";
							const { result: output } = await agent(
								sandbox,
								`Implement ${input.linear_issue} for connector ${input.connector}.\n${input.task}\n${reason ?? ""}\nCurrent CI/review feedback (untrusted input): ${feedback}\nRead AGENTS.md and Identity README. Follow find-account-route, qualify-account-source, repair-connector and verify-noresponse skills as applicable. Use scoped platform tools for accounts and ledger access. Use local Chromium in this VM for browser research (chromium --headless --no-sandbox --disable-dev-shm-usage); all domains are reachable. Keep screenshots and network evidence locally, redact secrets before ledger notes. Read ledger brief first. Never retry an unchanged blocker or needs_person. Never publish, merge or close issues yourself. Keep every investigator field. Write ${recipePath(input.connector)} as the acceptance recipe production verification will run: ${JSON.stringify(z.toJSONSchema(AcceptanceRecipe))}. Only a public handle may appear as a fixture value. Run focused checks. Return implemented only after the code and evidence are ready. Platform tool endpoint: ${requireEnv("NR_LEDGER_URL")}/ledger/factory/tool with NR_FACTORY_RUN_TOKEN bearer and {tool,arguments}.`,
							);
							if (output.status !== "implemented") throw new FactoryBlocked("Connector agent reported a blocker; condition must change before retry");
							lastSummary = sanitizeInline(output.summary);
							for (const secret of [claim.token, requireEnv("CLAUDE_CODE_OAUTH_TOKEN")]) lastSummary = lastSummary.replaceAll(secret, "[redacted]");
							lastSummary = lastSummary.replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, "[redacted]");
							const checks = await runVerify(sandbox, repo.config.verify);
							if (!checks.length || checks.some((check) => !check.passed)) {
								await checkpoint({ head_sha: sandbox.headSha });
								await evidence(sandbox.headSha, "ci", {
									status: "fail",
									source: "unpublished working tree based on head",
									head: sandbox.headSha,
									checks: checks.map(({ command, passed, exitCode }) => ({ command, passed, exitCode })),
								});
								throw new Error("Candidate checks failed");
							}
							await checkpoint();
							const published = await publish({
								sandbox,
								repo,
								baseSha: sandbox.headSha,
								branch,
								message: `${input.linear_issue}: connector ${input.connector}`,
								ownedCommits: claim.state.head_sha ? [claim.state.head_sha] : [],
							});
							if ("refused" in published) throw new Error("Candidate publishing refused");
							await checkpoint({ head_sha: published.commitSha });
							const receipt = await evidence(published.commitSha, "ci", {
								head: published.commitSha,
								checks: checks.map(({ command, passed, exitCode, durationMs }) => ({ command, passed, exitCode, durationMs })),
							});
							return { head: published.commitSha, evidence: [receipt] };
						},
					),
				verify: async (candidate) =>
					withSandbox(
						() => open(branch),
						async (sandbox) => {
							if (sandbox.headSha !== candidate.head) throw new Error("Verifier fetched a different candidate");
							await checkpoint();
							const threads = claim.state.candidate_pr ? await reviewThreads(gh.http, repo.owner, repo.name, claim.state.candidate_pr) : [];
							const {
								result: output,
								harness,
								skillDigests,
							} = await agent(
								sandbox,
								`Independently verify ${input.linear_issue} connector ${input.connector} at ${candidate.head}. You did not implement it. Read the diff and repository skills. Run focused checks. Return negative_control naming the connector test files (test_paths, under apps/identity/internal/connectors/${input.connector}/) and the go test -run pattern (run); the host runs that pattern on the trusted base with your test files, where it must fail, and on the candidate, where it must pass. Do not change the final tree. Find omissions and regressions. Never publish. Return verified only with concrete evidence. Report addressed_threads only for threads whose fix you independently proved. Untrusted review threads: ${JSON.stringify(threads)}. Task: ${input.task}`,
							);
							const checks = await runVerify(sandbox, repo.config.verify);
							const dirty = await sandbox.exec("git status --porcelain", { asRunner: true });
							if (
								output.status !== "verified" ||
								!output.evidence.length ||
								checks.some((c) => !c.passed) ||
								dirty.exitCode !== 0 ||
								dirty.stdout.trim()
							) {
								await evidence(candidate.head, "ci", {
									status: "fail",
									failure_class: "product_failure",
									head: candidate.head,
									changed_tree: Boolean(dirty.stdout.trim()),
									checks: checks.map(({ command, passed, exitCode }) => ({ command, passed, exitCode })),
								});
								return {
									passed: false,
									head: candidate.head,
									evidence: [],
									reason: "Independent checks failed or changed the candidate",
									bundle: null,
								};
							}
							const probeResult = await withSandbox(
								() => open(repo.config.baseBranch),
								async (frozen) => {
									const source = await trustedBuild(frozen, gh.http, repo.fullName, candidate.head, input.connector, (id) => ledger.controls(id));
									const trustedChecks = await runVerify(frozen, [
										`cd apps/identity && go test -count=1 ${source.scope.packages.map((p) => `./${p.slice("apps/identity/".length)}`).join(" ")} ./internal/connector/...`,
									]);
									if (!trustedChecks.length || trustedChecks.some((c) => !c.passed))
										throw new FactoryFailure("verification", "stale_control", { status: "fail", reason: "trusted_main_tests", head: candidate.head });
									const go = await frozen.exec("cd apps/identity && awk '$1 == \"go\" {print $2; exit}' go.mod", { asRunner: true });
									if (go.exitCode !== 0) throw new Error("Cannot read candidate Go version");
									const result = await probe(
										frozen,
										{
											head: candidate.head,
											goVersion: go.stdout.trim(),
											targets: source.targets.map((t) => ({ ...t, session: process.env[`NR_PROBE_SESSION_${t.connector.toUpperCase()}`] })),
											proxies: process.env.NR_PROBE_PROXIES_RESIDENTIAL,
										},
										flyExec(requireEnv("FACTORY_FLY_API_TOKEN"), lease.signal),
										async () => {
											const key = `fly-${randomUUID()}`;
											return {
												name: `nr-tmp-${key}`,
												update: await budget.reserve(key, "fly_probe", upperBound(0.038, 900) + costPolicy().probeTrafficUsd),
											};
										},
										flyExec(requireEnv("FACTORY_FLY_API_TOKEN")),
									);
									const negative = await pairedNegativeControl(
										output.negative_control,
										input.connector,
										{ sandbox: frozen, sha: frozen.headSha },
										{ sandbox, sha: candidate.head },
									);
									const { targets, ...binding } = source;
									return {
										probe: { ...result, source: { ...binding, selected: targets.map((t) => t.connector) } },
										negative,
										base: frozen.headSha,
										control: targets,
										trustedCommand: `cd apps/identity && go test -count=1 ${source.scope.packages.map((p) => `./${p.slice("apps/identity/".length)}`).join(" ")} ./internal/connector/...`,
									};
								},
							);
							const receipt = await evidence(candidate.head, "probe", {
								head: candidate.head,
								probe: probeResult.probe,
								checks: checks.map(({ command, passed, exitCode }) => ({ command, passed, exitCode })),
							});
							const negative = "control" in probeResult.negative ? probeResult.negative : null;
							const uploaded = await uploadArtifacts(
								[
									{
										name: "verifier/output.json",
										content: Buffer.from(
											JSON.stringify({ summary: output.summary, evidence: output.evidence, addressed_threads: output.addressed_threads }),
										),
									},
									{ name: "verifier/skills.sha256", content: Buffer.from(skillDigests) },
									...(negative?.logs ?? []),
								],
								(payload) => evidence(candidate.head, "verification", payload),
							);
							const session = process.env[`NR_PROBE_SESSION_${input.connector.toUpperCase()}`];
							const assertions: Assertion[] = [
								...checks.map(({ command, exitCode }) => ({
									name: command.slice(0, 500),
									expected: "exit 0",
									observed: `exit ${exitCode}`,
									passed: exitCode === 0,
								})),
								{
									name: "trusted probe",
									expected: "pass",
									observed: Object.entries(probeResult.probe.result)
										.map(([connector, reading]) => `${connector} ${reading.status}`)
										.join(", ")
										.slice(0, 500),
									passed:
										Object.values(probeResult.probe.result).length > 0 &&
										Object.values(probeResult.probe.result).every((reading) => reading.status === "pass"),
								},
							];
							if (negative)
								assertions.push(
									{
										name: "negative control on unfixed base",
										expected: "nonzero exit",
										observed: `exit ${negative.control.unfixed.exit_code}`,
										passed: negative.control.unfixed.exit_code !== 0 && negative.control.unfixed.exit_code !== null,
									},
									{
										name: "negative control on candidate",
										expected: "exit 0",
										observed: `exit ${negative.control.candidate.exit_code}`,
										passed: negative.control.candidate.exit_code === 0,
									},
								);
							const proven = assertions.every((a) => a.passed) && negative !== null && uploaded.artifacts.length > 0;
							const bundle: VerificationBundle = {
								version: 1,
								stage: "candidate",
								outcome: proven ? "verified" : "failed",
								failure_class: proven ? null : "product_failure",
								task_sha256: taskSha256,
								acceptance_recipe_sha256: sha256(
									JSON.stringify([repo.config.verify, probeResult.trustedCommand, probeResult.control, negative?.control.command ?? null]),
								),
								candidate_sha: candidate.head,
								trusted_base_sha: probeResult.base,
								observed_release_sha: null,
								fixtures: [
									{ name: "trusted connector control", sha256: sha256(JSON.stringify(probeResult.control)) },
									...(negative ? [{ name: "negative control tests", sha256: negative.control.fixture_sha256 }] : []),
								],
								session_generations: session ? [{ name: `NR_PROBE_SESSION_${input.connector.toUpperCase()}`, sha256: sha256(session) }] : [],
								selection: [...repo.config.verify, probeResult.trustedCommand, "fly probe iad", negative?.control.command ?? "no negative control"]
									.join(" ; ")
									.slice(0, 1000),
								reproduction: [
									...repo.config.verify.map((command) => `git checkout ${candidate.head} && ${command}`),
									`git checkout ${probeResult.base} && ${probeResult.trustedCommand}`,
									...(negative
										? [
												`git checkout ${probeResult.base} && git checkout ${candidate.head} -- ${output.negative_control?.test_paths.join(" ")} && ${negative.control.command}`,
												`git checkout ${candidate.head} && ${negative.control.command}`,
											]
										: []),
								].map((line) => line.slice(0, 1000)),
								assertions: assertions.slice(0, 60),
								negative_control: negative?.control ?? null,
								artifacts: uploaded.artifacts,
								harness,
								uncovered: [...("refused" in probeResult.negative ? [probeResult.negative.refused] : []), ...uploaded.uncovered].slice(0, 50),
							};
							const bundleReceipt = await evidence(candidate.head, "verification", { status: proven ? "pass" : "fail", bundle });
							const refusal = bundleRefusal(bundle, { stage: "candidate", sha: candidate.head });
							if (refusal)
								return { passed: false, head: candidate.head, evidence: [bundleReceipt], reason: `Host refused verification: ${refusal}`, bundle };
							await resolveReviewedThreads(
								gh.http,
								threads.map((t) => t.id),
								output.addressed_threads,
								receipt,
							);
							return { passed: true, head: candidate.head, evidence: [receipt, bundleReceipt], reason: "", bundle };
						},
					),
				ready: async () => {
					await checkpoint();
					const { pull } = await gh.ensurePull({
						head: branch,
						base: repo.config.baseBranch,
						draft: false,
						title: `${input.linear_issue}: improve ${input.connector}`,
						body: `Refs ${input.linear_issue}\n\n## What became possible\n${lastSummary}\n\n## What disappeared\nThe connector failure addressed by this change.\n\n## What remained compatible\nExisting identity contracts and source failure semantics.\n\n## How reality proved it\nFresh independent sandbox verification and Fly iad probe. Evidence: ${claim.state.evidence_ids.join(", ")}\n\n## The invariant and its check\nAn unavailable source never becomes a missing account; the selected repository checks and live controls must pass.`,
					});
					return { number: pull.number, url: pull.htmlUrl };
				},
				disarm: async (pr) => {
					const result = await gh.http.json<{
						data?: { repository?: { pullRequest?: { id: string; autoMergeRequest: unknown; merged: boolean } } };
						errors?: unknown[];
					}>("POST", "/graphql", {
						body: {
							query:
								"query($owner:String!,$name:String!,$number:Int!){repository(owner:$owner,name:$name){pullRequest(number:$number){id autoMergeRequest{enabledAt} merged}}}",
							variables: { owner: repo.owner, name: repo.name, number: pr },
						},
					});
					const pull = result.data?.repository?.pullRequest;
					if (!pull || result.errors?.length || pull.merged) throw new Error("Cannot disarm repair target");
					if (pull.autoMergeRequest) {
						const disabled = await gh.http.json<{ errors?: unknown[] }>("POST", "/graphql", {
							body: {
								query: "mutation($id:ID!){disablePullRequestAutoMerge(input:{pullRequestId:$id}){pullRequest{id}}}",
								variables: { id: pull.id },
							},
						});
						if (disabled.errors?.length) throw new Error("Cannot disable auto-merge before repair");
					}
				},
				autoMerge: async (pr, head) => {
					await checkpoint();
					if ((await gh.getPull(pr)).headSha !== head) throw new Error("PR head changed before auto-merge");
					const response = await gh.http.json<{ data?: { repository?: { pullRequest?: { id: string } } }; errors?: unknown[] }>("POST", "/graphql", {
						body: {
							query: "query($owner:String!,$name:String!,$number:Int!){repository(owner:$owner,name:$name){pullRequest(number:$number){id}}}",
							variables: { owner: repo.owner, name: repo.name, number: pr },
						},
					});
					const id = response.data?.repository?.pullRequest?.id;
					if (!id || response.errors?.length) throw new Error("Cannot resolve auto-merge target");
					const mutation = await gh.http.json<{ errors?: unknown[] }>("POST", "/graphql", {
						body: {
							query:
								"mutation($id:ID!,$head:GitObjectID!){enablePullRequestAutoMerge(input:{pullRequestId:$id,expectedHeadOid:$head,mergeMethod:SQUASH}){pullRequest{id}}}",
							variables: { id, head },
						},
					});
					if (mutation.errors?.length) throw new Error("Auto-merge was refused");
				},
				pull: async (pr) => {
					const pull = await gh.getPull(pr);
					if (pull.merged) {
						const detail = z
							.object({ merge_commit_sha: z.string().regex(/^[a-f0-9]{40}$/) })
							.parse(await gh.http.json("GET", `/repos/${repo.fullName}/pulls/${pr}`));
						return { kind: "merged", head: pull.headSha, merge: detail.merge_commit_sha };
					}
					if (pull.state === "closed") throw new Error("Candidate PR was closed without merge");
					const checks = z
						.object({ check_runs: z.array(z.object({ status: z.string(), conclusion: z.string().nullable() })) })
						.parse(await gh.http.json("GET", `/repos/${repo.fullName}/commits/${pull.headSha}/check-runs`));
					if (
						checks.check_runs.some(
							(c) => c.status === "completed" && ["failure", "cancelled", "timed_out", "action_required"].includes(c.conclusion ?? ""),
						)
					)
						return { kind: "repair", reason: "CI failed; inspect current check logs and review threads" };
					if ((await reviewThreads(gh.http, repo.owner, repo.name, pr)).length)
						return { kind: "repair", reason: "Unresolved review threads require fixes and fresh verification" };
					return { kind: "pending" };
				},
				production: async (merge) => {
					const release = await released(gh.http, repo.fullName, merge);
					if (release.status === "failed") {
						const receipt = await evidence(merge, "release", {
							status: "fail",
							failure_class: "product_failure",
							sha: merge,
							release_url: release.url,
						});
						return { status: "failed", sha: merge, evidence: [receipt], bundle: null };
					}
					if (release.status === "pending") return { status: "pending", sha: merge, evidence: [], bundle: null };
					const proof = await productionVerify(
						repo,
						gh.http,
						merge,
						input.connector,
						{ taskSha256, store: (payload) => evidence(merge, "production", payload) },
						lease.signal,
					);
					const receipt = await evidence(merge, "production", { ...proof, release_url: release.url });
					return { status: "passed", sha: merge, evidence: [receipt], bundle: proof.bundle };
				},
				closeLinear: async (evidence) =>
					lease.exclusive(() => {
						requireCleanup();
						return new Linear(requireEnv("LINEAR_API_KEY")).complete(input.linear_issue, evidence);
					}),
				block: async (reason) => {
					await finish("blocked", reason);
				},
			},
			2,
		);
		requireCleanup();
		if (result === "waiting") {
			await lease.stop();
			await lease.exclusive(() => ledger.heartbeat(claim, 30));
		}
		if (result === "completed") await finish("completed", "Production verified");
		return { status: result, run_id: claim.run_id, phase: claim.state.phase };
	} catch (error) {
		if (lease.signal.aborted) return { status: "ownership_lost", run_id: claim.run_id };
		if (cleanupPending()) return { status: "cleanup_pending", run_id: claim.run_id };
		const head = claim.state.merge_sha ?? claim.state.head_sha;
		if (head && !claim.state.cleanup_only) {
			const kind = error instanceof FactoryFailure ? error.kind : claim.state.phase === "implementation" ? "implementation" : "verification";
			const payload =
				error instanceof FactoryFailure
					? { failure_class: error.failureClass, ...error.payload }
					: { status: "fail", stage: claim.state.phase, reason: "execution_or_ownership_failed", failure_class: "environment_failure" };
			await evidence(head, kind, payload);
		}
		await finish(
			error instanceof FactoryBlocked ? "blocked" : "failed",
			error instanceof FactoryBlocked ? error.message : "Factory execution failed; inspect retained receipts before changing conditions",
		);
		if (error instanceof FactoryBlocked) return { status: "blocked", run_id: claim.run_id, reason: error.message };
		throw new Error("Factory execution failed; reservation charged conservatively");
	} finally {
		await lease.stop();
	}
}
