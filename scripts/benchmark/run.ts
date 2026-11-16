import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { type AcceptanceRun, type Case, type CaseResult, Corpus, Observation, RunResult } from "./schema.js";
import { scoreCase, totals } from "./score.js";

export const CORPUS_PATH = join(dirname(fileURLToPath(import.meta.url)), "corpus.json");

export function loadCorpus(path = CORPUS_PATH) {
	const raw = readFileSync(path, "utf8");
	return { corpus: Corpus.parse(JSON.parse(raw)), sha256: createHash("sha256").update(raw).digest("hex") };
}

export function select(corpus: Corpus, only: string[] | undefined): Case[] {
	if (!only?.length) return corpus.cases;
	const unknown = only.filter((id) => !corpus.cases.some((c) => c.id === id));
	if (unknown.length) throw new Error(`unknown case ids: ${unknown.join(", ")}`);
	return corpus.cases.filter((c) => only.includes(c.id));
}

function git(repo: string, args: string[]) {
	return spawnSync("git", ["-C", repo, ...args], { encoding: "utf8" });
}

export function checkPins(cases: Case[], repo: string): string[] {
	const problems: string[] = [];
	for (const c of cases) {
		if (git(repo, ["cat-file", "-e", `${c.base_commit}^{commit}`]).status !== 0) problems.push(`${c.id}: base ${c.base_commit} is not in ${repo}`);
		if (c.source.kind === "historical") {
			const parent = git(repo, ["rev-parse", `${c.source.fix_commit}^1`]).stdout.trim();
			if (parent !== c.base_commit) problems.push(`${c.id}: base must be the parent of fix ${c.source.fix_commit}, got ${parent || "nothing"}`);
		}
		if (c.source.kind === "inverted" && c.base_commit !== c.source.fix_commit) problems.push(`${c.id}: an inverted case starts from its fix commit`);
		for (const file of c.acceptance?.trusted_files ?? []) {
			const from = c.source.kind === "synthetic" ? c.base_commit : c.source.fix_commit;
			if (git(repo, ["cat-file", "-e", `${from}:${file}`]).status !== 0) problems.push(`${c.id}: trusted file ${file} is not in ${from}`);
		}
	}
	return problems;
}

export function oracle(c: Case): Observation {
	return c.expected.outcome === "complete"
		? { verdict: "complete", candidate_commit: c.base_commit, cost_usd: 0, human_interventions: 0, duration_seconds: 0 }
		: { verdict: c.expected.outcome, reason: c.expected.reason, cost_usd: 0, human_interventions: 0, duration_seconds: 0 };
}

export function alwaysAccept(c: Case): Observation {
	return { verdict: "complete", candidate_commit: c.base_commit, cost_usd: 0, human_interventions: 0, duration_seconds: 0 };
}

export type Executor = (c: Case) => Promise<Observation>;
export type Acceptor = (c: Case, candidate: string) => Promise<AcceptanceRun>;

export async function runCase(c: Case, execute: Executor, accept: Acceptor): Promise<CaseResult> {
	let observation: Observation;
	try {
		observation = Observation.parse(await execute(c));
	} catch (error) {
		observation = { verdict: "environment_failure", cost_usd: 0, human_interventions: 0, duration_seconds: 0, detail: String(error).slice(0, 2000) };
	}
	let acceptance: AcceptanceRun = { status: "not_run", exit_code: null };
	if (observation.verdict === "complete" && c.expected.outcome === "complete") {
		acceptance = observation.candidate_commit
			? await accept(c, observation.candidate_commit)
			: { status: "failed", exit_code: null, detail: "the factory reported complete without a candidate commit" };
	}
	return { id: c.id, category: c.category, expected: c.expected.outcome, observation, acceptance, score: scoreCase(c, observation, acceptance) };
}

function missingRequirement(requires: string[]): string | undefined {
	for (const need of requires) {
		if (need === "postgres") {
			if (!process.env.DATABASE_URL && !process.env.TEST_DATABASE_URL) return "postgres (set DATABASE_URL or TEST_DATABASE_URL)";
		} else if (spawnSync("sh", ["-c", `command -v ${need}`]).status !== 0) return need;
	}
	return undefined;
}

export function trustedAcceptor(repo: string, timeoutSeconds: number): Acceptor {
	return async (c, candidate) => {
		const check = c.acceptance;
		if (!check) return { status: "not_run", exit_code: null, detail: "no trusted check" };
		const missing = missingRequirement(check.requires);
		if (missing) return { status: "not_run", exit_code: null, detail: `missing ${missing}` };
		git(repo, ["fetch", "--quiet", "origin", candidate]);
		if (git(repo, ["merge-base", "--is-ancestor", c.base_commit, candidate]).status !== 0)
			return { status: "failed", exit_code: null, detail: `candidate ${candidate} does not descend from the pinned base` };
		const dir = mkdtempSync(join(tmpdir(), "nr-benchmark-"));
		try {
			if (git(repo, ["worktree", "add", "--detach", "--quiet", dir, candidate]).status !== 0)
				return { status: "not_run", exit_code: null, detail: "could not check out the candidate" };
			const from = c.source.kind === "synthetic" ? c.base_commit : c.source.fix_commit;
			for (const file of check.trusted_files) {
				if (git(dir, ["checkout", from, "--", file]).status !== 0) return { status: "not_run", exit_code: null, detail: `could not restore ${file}` };
			}
			const run = spawnSync("sh", ["-c", check.command], { cwd: join(dir, check.cwd), encoding: "utf8", timeout: timeoutSeconds * 1000 });
			const tail = `${run.stdout ?? ""}${run.stderr ?? ""}`.slice(-2000);
			if (run.error) return { status: "not_run", exit_code: null, detail: `${run.error.message} ${tail}`.slice(0, 2000) };
			return { status: run.status === 0 ? "passed" : "failed", exit_code: run.status, detail: tail };
		} finally {
			git(repo, ["worktree", "remove", "--force", dir]);
			rmSync(dir, { recursive: true, force: true });
		}
	};
}

export function commandExecutor(command: string, timeoutSeconds: number): Executor {
	return async (c) => {
		const run = spawnSync("sh", ["-c", command], { input: JSON.stringify(c), encoding: "utf8", timeout: timeoutSeconds * 1000 });
		if (run.error || run.status !== 0)
			throw new Error(`executor failed (${run.error?.message ?? `exit ${run.status}`}): ${(run.stderr ?? "").slice(-1000)}`);
		const lines = run.stdout.trim().split("\n");
		return Observation.parse(JSON.parse(lines[lines.length - 1] ?? ""));
	};
}

type Options = { mode: "dry" | "live"; only?: string[]; out?: string; repo: string; timeoutSeconds: number };

function parseArgs(argv: string[]): Options {
	const options: Options = { mode: "live", repo: process.env.NORESPONSE_REPO ?? join(homedir(), "projects/noresponse"), timeoutSeconds: 4 * 3600 };
	for (let i = 0; i < argv.length; i++) {
		const arg = argv[i];
		if (arg === "--dry") options.mode = "dry";
		else if (arg === "--only") options.only = (argv[++i] ?? "").split(",").filter(Boolean);
		else if (arg === "--out") options.out = argv[++i];
		else if (arg === "--repo") options.repo = argv[++i] ?? options.repo;
		else if (arg === "--timeout") options.timeoutSeconds = Number(argv[++i]);
		else throw new Error(`unknown argument ${arg}`);
	}
	return options;
}

function factoryCommit() {
	return spawnSync("git", ["rev-parse", "HEAD"], { encoding: "utf8", cwd: dirname(CORPUS_PATH) }).stdout.trim() || "unknown";
}

function requireIdentity(name: string) {
	const value = process.env[name];
	if (!value) throw new Error(`live mode needs ${name} so results are comparable across runs`);
	return value;
}

export async function main(argv: string[]) {
	const options = parseArgs(argv);
	const { corpus, sha256 } = loadCorpus();
	const cases = select(corpus, options.only);
	const started = new Date().toISOString();
	let results: CaseResult[];
	let identity: RunResult["identity"];

	if (options.mode === "dry") {
		const repo = existsSync(options.repo) ? options.repo : undefined;
		const problems = repo ? checkPins(cases, repo) : [];
		const passing: Acceptor = async () => ({ status: "passed", exit_code: 0 });
		const failing: Acceptor = async () => ({ status: "failed", exit_code: 1 });
		if (problems.length) throw new Error(`corpus pins are wrong:\n${problems.join("\n")}`);
		results = await Promise.all(cases.map((c) => runCase(c, async () => oracle(c), passing)));
		const adversarial = totals(await Promise.all(cases.map((c) => runCase(c, async () => alwaysAccept(c), failing))));
		const oracleTotals = totals(results);
		if (oracleTotals.reliability !== 1) throw new Error("the scorer does not give the expected outcomes full marks");
		if (adversarial.incorrect_acceptance !== cases.length || adversarial.reliability !== 0)
			throw new Error("the scorer does not count every false acceptance as a failure");
		process.stderr.write(
			`dry: ${cases.length} cases valid; pins ${repo ? `checked against ${repo}` : "unchecked (no product checkout)"}; oracle reliability 1; always-accept scores ${adversarial.incorrect_acceptance} incorrect acceptances\n`,
		);
		identity = { model: "none", harness: "dry", harness_version: "none", factory_commit: factoryCommit(), executor: "dry:oracle" };
	} else {
		const executor = requireIdentity("BENCHMARK_EXECUTOR");
		identity = {
			model: requireIdentity("BENCHMARK_MODEL"),
			harness: requireIdentity("BENCHMARK_HARNESS"),
			harness_version: requireIdentity("BENCHMARK_HARNESS_VERSION"),
			factory_commit: process.env.BENCHMARK_FACTORY_COMMIT ?? factoryCommit(),
			executor,
		};
		const execute = commandExecutor(executor, options.timeoutSeconds);
		const accept = trustedAcceptor(options.repo, 1800);
		results = [];
		for (const c of cases) {
			const result = await runCase(c, execute, accept);
			process.stderr.write(`${c.id}: ${result.score}\n`);
			results.push(result);
		}
	}

	const result = RunResult.parse({
		schema_version: 1,
		mode: options.mode,
		started_at: started,
		finished_at: new Date().toISOString(),
		corpus_sha256: sha256,
		identity,
		selection: cases.map((c) => c.id),
		cases: results,
		totals: totals(results),
	});
	const out = resolve(options.out ?? join("benchmark-results", `${options.mode}-${started.replace(/[:.]/g, "-")}.json`));
	mkdirSync(dirname(out), { recursive: true });
	writeFileSync(out, `${JSON.stringify(result, null, "\t")}\n`);
	process.stdout.write(`${JSON.stringify({ out, totals: result.totals })}\n`);
	return result;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
	main(process.argv.slice(2)).catch((error) => {
		process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
		process.exitCode = 1;
	});
}
