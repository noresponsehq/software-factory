/** doctor --live: compares what Render runs with the intended factory revision and runs the in-service probe. */
import { z } from "zod";
import { TASKS } from "../../app/config/index.js";
import { DeploymentProbe, PROBE_CHECKS } from "../../app/schemas/index.js";
import type { Env } from "./github.js";
import { errorMessage, type Reporter } from "./output.js";

export interface DeploymentOptions {
	env: Env;
	/** The full commit SHA every factory service must run. */
	revision: string;
	fetch?: typeof fetch;
	sleep?: (ms: number) => Promise<void>;
	renderApiUrl?: string;
	probeTimeoutMs?: number;
}

export const WORKFLOW_NAME = "factory-workflows";
export const SERVICE_NAMES = ["factory-gateway", "factory-intake"] as const;

const Workflow = z.object({ id: z.string(), name: z.string(), slug: z.string() });
const WorkflowVersion = z.object({ id: z.string(), name: z.string(), status: z.string(), createdAt: z.string() });
const Task = z.object({ name: z.string(), workflowVersionId: z.string() });
const Service = z.object({ id: z.string(), name: z.string(), suspended: z.string().optional() });
const Deploy = z.object({ id: z.string(), status: z.string(), commit: z.object({ id: z.string() }).nullish() });
const TaskRun = z.object({ id: z.string(), status: z.string(), results: z.array(z.unknown()).nullish(), error: z.string().nullish() });
const TERMINAL = new Set(["succeeded", "completed", "failed", "canceled"]);

export async function checkDeployment(opts: DeploymentOptions, out: Reporter): Promise<void> {
	const { env, revision } = opts;
	const short = revision.slice(0, 7);
	out.heading(`Live deployment (intended revision ${short})`);
	if (!/^[0-9a-f]{40}$/.test(revision)) {
		out.fail(`intended revision ${JSON.stringify(revision)} is not a full commit SHA`, "Pass --revision <40-character SHA>");
		return;
	}
	const apiKey = env.RENDER_API_KEY?.trim();
	const owner = env.RENDER_WORKSPACE_ID?.trim();
	if (!apiKey || !owner) {
		out.fail("live deployment is unverified: RENDER_API_KEY and RENDER_WORKSPACE_ID are required");
		return;
	}
	out.addSecrets(apiKey);
	const base = (opts.renderApiUrl ?? "https://api.render.com").replace(/\/+$/, "");
	const request = opts.fetch ?? fetch;
	const render = async <T>(path: string, schema: z.ZodType<T>, init: RequestInit = {}): Promise<T> => {
		const response = await request(`${base}/v1/${path}`, {
			...init,
			headers: { Authorization: `Bearer ${apiKey}`, Accept: "application/json", "Content-Type": "application/json" },
			signal: AbortSignal.timeout(15_000),
		});
		if (!response.ok) throw new Error(`Render answered ${response.status} for ${init.method ?? "GET"} /v1/${path.split("?")[0]}`);
		return schema.parse(await response.json());
	};
	const rows = <K extends string, T extends z.ZodTypeAny>(key: K, item: T) => z.array(z.object({ [key]: item } as Record<K, T>)).nullable();

	let workflow: z.infer<typeof Workflow> | undefined;
	try {
		const slug = env.RENDER_WORKFLOW_SLUG?.trim();
		const workflows = (await render(`workflows?ownerId=${owner}&limit=100`, rows("workflow", Workflow))) ?? [];
		workflow = workflows.map((row) => row.workflow).find((w) => (slug ? w.slug === slug : w.name === WORKFLOW_NAME));
		if (!workflow) {
			out.fail(
				`no Workflow named ${slug ?? WORKFLOW_NAME} exists in ${owner}`,
				"Create it from the NOR-1436 branch and release the intended revision",
			);
		} else {
			out.pass(`Workflow ${workflow.name} exists (${workflow.id}, slug ${workflow.slug})`);
		}
	} catch (error) {
		out.fail(`Workflows are unverified: ${errorMessage(error)}`);
	}

	if (workflow) {
		try {
			const versions = ((await render(`workflowversions?workflowId=${workflow.id}&limit=20`, rows("workflowVersion", WorkflowVersion))) ?? [])
				.map((row) => row.workflowVersion)
				.filter((v) => v.status === "ready")
				.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
			const current = versions[0];
			if (!current)
				out.fail(`${workflow.name} has no ready version`, `Run \`render workflows versions release ${workflow.id} --commit ${revision}\``);
			else if (!revision.startsWith(current.name)) {
				out.fail(
					`${workflow.name} runs ${current.name}, not ${short}`,
					`Run \`render workflows versions release ${workflow.id} --commit ${revision}\``,
				);
			} else out.pass(`${workflow.name} runs ${current.name}`);

			if (current) {
				const tasks = ((await render(`tasks?workflowId=${workflow.id}&limit=100`, rows("task", Task))) ?? []).map((row) => row.task);
				const missing = Object.values(TASKS).filter((name) => !tasks.some((t) => t.name === name && t.workflowVersionId === current.id));
				if (missing.length) out.fail(`tasks not registered on version ${current.name}: ${missing.join(", ")}`, "Release the intended revision again");
				else out.pass(`version ${current.name} registers ${Object.values(TASKS).join(", ")}`);
			}
		} catch (error) {
			out.fail(`Workflow version and tasks are unverified: ${errorMessage(error)}`);
		}
	}

	for (const name of SERVICE_NAMES) {
		try {
			const service = ((await render(`services?ownerId=${owner}&name=${name}&limit=20`, rows("service", Service))) ?? [])
				.map((row) => row.service)
				.find((s) => s.name === name);
			if (!service) {
				out.fail(`service ${name} does not exist`, "Create it as render.yaml declares, from the intended revision");
				continue;
			}
			const deploys = ((await render(`services/${service.id}/deploys?limit=20`, rows("deploy", Deploy))) ?? []).map((row) => row.deploy);
			const live = deploys.find((d) => d.status === "live");
			if (!live) out.fail(`${name} has no live deploy`, `Deploy commit ${revision}`);
			else if (live.commit?.id === revision) out.pass(`${name} runs ${short} (${live.id})`);
			else if (service.suspended === "suspended") {
				out.warn(
					`${name} is suspended on ${live.commit?.id?.slice(0, 7) ?? "an unknown commit"}, not ${short}`,
					`Deploy commit ${revision} before resuming it`,
				);
			} else out.fail(`${name} runs ${live.commit?.id?.slice(0, 7) ?? "an unknown commit"}, not ${short}`, `Deploy commit ${revision}`);
			if (service.suspended === "suspended")
				out.warn(`${name} is suspended and dispatches nothing`, "Resume it only when the factory should take work");
		} catch (error) {
			out.fail(`service ${name} is unverified: ${errorMessage(error)}`);
		}
	}

	if (workflow) await runProbe(workflow.slug, revision, render, opts, out);
}

async function runProbe(
	slug: string,
	revision: string,
	render: <T>(path: string, schema: z.ZodType<T>, init?: RequestInit) => Promise<T>,
	opts: DeploymentOptions,
	out: Reporter,
): Promise<void> {
	const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
	let run: z.infer<typeof TaskRun>;
	try {
		run = await render("task-runs", TaskRun, { method: "POST", body: JSON.stringify({ task: `${slug}/${TASKS.doctor}`, input: [] }) });
		const deadline = Date.now() + (opts.probeTimeoutMs ?? 10 * 60_000);
		while (!TERMINAL.has(run.status)) {
			if (Date.now() > deadline) throw new Error(`probe run ${run.id} still ${run.status} at its deadline`);
			await sleep(5_000);
			run = await render(`task-runs/${run.id}`, TaskRun);
		}
	} catch (error) {
		out.fail(`in-service probe did not run: ${errorMessage(error)}`, "Check the Workflow logs");
		return;
	}
	if (run.status !== "succeeded" && run.status !== "completed") {
		out.fail(`in-service probe run ${run.id} ${run.status}: ${(run.error ?? "no error given").slice(0, 200)}`, "Check the Workflow logs");
		return;
	}
	const probe = DeploymentProbe.safeParse(run.results?.[0]);
	if (!probe.success) {
		out.fail(`in-service probe run ${run.id} returned an unexpected result`, "Release the intended revision, which defines the doctor task");
		return;
	}
	if (probe.data.revision && probe.data.revision !== revision) {
		out.fail(`in-service probe ran on ${probe.data.revision.slice(0, 7)}, not ${revision.slice(0, 7)}`);
	}
	for (const name of PROBE_CHECKS.filter((n) => !probe.data.checks.some((c) => c.name === n))) out.fail(`in-service probe did not report ${name}`);
	for (const check of probe.data.checks) {
		if (check.ok) out.pass(`deployed factory: ${check.name}: ${check.detail}`);
		else out.fail(`deployed factory cannot reach ${check.name}: ${check.detail}`, "Check the workflows env group and the service's network");
	}
	out.line(`probe run ${run.id}`);
}
