import { Render } from "@renderinc/sdk";
import { requireEnv } from "../app/config/index.js";
import { accountDaily } from "../app/connectors/accounting.js";
import { intake } from "../app/connectors/intake.js";

const render = new Render({ token: requireEnv("RENDER_API_KEY") });
await accountDaily();
const result = await intake((input, idempotencyKey, task = "connector") =>
	render.workflows.startTask(`${requireEnv("RENDER_WORKFLOW_SLUG")}/${task}`, [input], { idempotencyKey }),
);
process.stdout.write(`${JSON.stringify(result)}\n`);
