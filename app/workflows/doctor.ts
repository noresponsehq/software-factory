import { task } from "@renderinc/sdk/workflows";
import { z } from "zod";
import { requireEnv, TASKS } from "../config/index.js";
import { githubToken } from "../github/index.js";
import { type SandboxClient, sandboxClient } from "../sandbox/index.js";
import { DeploymentProbe } from "../schemas/index.js";

export interface ProbeDeps {
	env?: Readonly<Record<string, string | undefined>>;
	fetch?: typeof fetch;
	sandbox?: () => SandboxClient;
	githubToken?: typeof githubToken;
}

const NORESPONSE_API = "https://api.noresponse.org/version";

/**
 * Proves from inside the deployed Workflows service that it can open and terminate a sandbox and reach the ledger
 * Worker, GitHub and the noresponse API with the credentials it holds. Reports outcomes only, never a credential.
 */
export async function probeDeployment(deps: ProbeDeps = {}): Promise<DeploymentProbe> {
	const env = deps.env ?? process.env;
	const request = deps.fetch ?? fetch;
	const checks: DeploymentProbe["checks"] = [];
	const run = async (name: DeploymentProbe["checks"][number]["name"], fn: () => Promise<string>) => {
		try {
			checks.push({ name, ok: true, detail: (await fn()).slice(0, 300) });
		} catch (error) {
			checks.push({ name, ok: false, detail: (error instanceof Error ? error.message : String(error)).slice(0, 300) });
		}
	};
	const ok = async (response: Response, what: string) => {
		if (!response.ok) throw new Error(`${what} answered ${response.status}`);
		return response.json() as Promise<unknown>;
	};

	await run("sandbox", async () => {
		const client = (deps.sandbox ?? sandboxClient)();
		const { id } = await client.call(() =>
			client.api.create({ name: "factory-doctor", timeoutSeconds: 300, idleTimeoutSeconds: 0, networkPolicy: { type: "deny-all" } }),
		);
		try {
			await client.waitRunning(id);
			await client.check(id, "true", { timeoutMs: 60_000, waitReady: true });
		} finally {
			await client.terminate(id);
		}
		await client.confirmTerminated(id);
		return `created, ran and terminated ${id}`;
	});

	await run("ledger", async () => {
		const base = requireEnv("NR_LEDGER_URL").replace(/\/+$/, "");
		const data = await ok(
			await request(`${base}/ledger/factory/cursor`, {
				headers: { Authorization: `Bearer ${requireEnv("NR_FACTORY_OPERATOR_TOKEN")}` },
				redirect: "error",
				signal: AbortSignal.timeout(15_000),
			}),
			"ledger cursor",
		);
		return `cursor ${z.object({ after: z.number().int().nonnegative() }).parse(data).after}`;
	});

	await run("github", async () => {
		const installationId = Number(requireEnv("FACTORY_GITHUB_INSTALLATION_ID"));
		const token = await (deps.githubToken ?? githubToken)({ installationId, repo: "noresponse", permissions: { metadata: "read" }, fetch: request });
		const data = await ok(
			await request("https://api.github.com/repos/noresponsehq/noresponse", {
				headers: { Authorization: `Bearer ${token}`, Accept: "application/vnd.github+json" },
				signal: AbortSignal.timeout(15_000),
			}),
			"GitHub repository",
		);
		return `read ${z.object({ full_name: z.string() }).parse(data).full_name} with installation ${installationId}`;
	});

	await run("noresponse_api", async () => {
		const data = await ok(await request(NORESPONSE_API, { signal: AbortSignal.timeout(15_000) }), "noresponse API");
		return `version ${JSON.stringify(data).slice(0, 120)}`;
	});

	return DeploymentProbe.parse({ revision: env.RENDER_GIT_COMMIT?.trim() || null, checks });
}

export const doctor = task({ name: TASKS.doctor, timeoutSeconds: 600, retry: { maxRetries: 0, waitDurationMs: 5_000, backoffScaling: 1 } }, () =>
	probeDeployment(),
);
