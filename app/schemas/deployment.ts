import { z } from "zod";

export const PROBE_CHECKS = ["sandbox", "ledger", "github", "noresponse_api"] as const;

export const DeploymentProbe = z.strictObject({
	revision: z.string().max(64).nullable(),
	checks: z.array(z.strictObject({ name: z.enum(PROBE_CHECKS), ok: z.boolean(), detail: z.string().max(300) })).max(PROBE_CHECKS.length),
});
export type DeploymentProbe = z.infer<typeof DeploymentProbe>;
