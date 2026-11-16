/**
 * Step 2 of setup, after the GitHub App exists and before the Blueprint is applied: create the Render environment
 * groups that render.yaml links, so the Blueprint deploys without asking for any value. Idempotent; never prints
 * a secret.
 *
 *   npm run setup:render [-- --workspace tea-…]
 *
 * Reads RENDER_API_KEY, RENDER_WORKSPACE_ID, the GitHub App values, and configured subscription credentials from the environment
 * or the main checkout credential file. --workspace overrides RENDER_WORKSPACE_ID and, after a successful run, saves it to that same file.
 */

import { readFile } from "node:fs/promises";
import { parseArgs } from "node:util";
import { config } from "../app/config/index.js";
import { accountDaily } from "../app/connectors/accounting.js";
import { credentialPath, MAIN_CREDENTIAL_FILE, writeEnvFile } from "./lib/env-file.js";
import { errorMessage, Reporter } from "./lib/output.js";
import { setupRenderWithPreflight } from "./lib/preflight.js";

const { values } = parseArgs({ options: { workspace: { type: "string" }, "credential-file": { type: "string", default: MAIN_CREDENTIAL_FILE } } });
const credentialFile = credentialPath(values["credential-file"]);
const workspace = values.workspace?.trim();

const out = new Reporter();
try {
	const env = workspace ? { ...process.env, RENDER_WORKSPACE_ID: workspace } : process.env;
	const requiredNodeMajor = Number.parseInt(await readFile(new URL("../.node-version", import.meta.url), "utf8"), 10);
	process.exitCode = await setupRenderWithPreflight({ env, repos: config.repos, nodeVersion: process.versions.node, requiredNodeMajor }, out);
	if (config.connectors && process.exitCode === 0) await accountDaily();
	if (workspace && process.exitCode === 0) {
		await writeEnvFile(credentialFile, { RENDER_WORKSPACE_ID: workspace });
		out.line(`Saved RENDER_WORKSPACE_ID=${workspace} to ${credentialFile}`);
	}
} catch (error) {
	out.fail(errorMessage(error));
	process.exitCode = 1;
}
