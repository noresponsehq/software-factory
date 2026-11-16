import { Render } from "@renderinc/sdk";
import { requireEnv } from "../app/config/index.js";
import { intake } from "../app/connectors/intake.js";

const render = new Render({ token: requireEnv("RENDER_API_KEY") });
const result = await intake((input, idempotencyKey) =>
	render.workflows.startTask(`${requireEnv("RENDER_WORKFLOW_SLUG")}/connector`, [input], { idempotencyKey }),
);
process.stdout.write(`${JSON.stringify(result)}\n`);
