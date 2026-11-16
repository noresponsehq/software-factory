import { task } from "@renderinc/sdk/workflows";
import { runConnector } from "../connectors/runtime.js";

export const connectorWorkflow = task(
	{ name: "connector", timeoutSeconds: 14400, retry: { maxRetries: 0, waitDurationMs: 1000, backoffScaling: 1 } },
	async (_ctx, input: unknown) => runConnector(input),
);
