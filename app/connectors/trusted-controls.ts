import { z } from "zod";
import { FactoryBlocked } from "./failure.js";

const Typed = z.discriminatedUnion("type", [
	z.strictObject({ type: z.literal("text"), value: z.string().min(1) }),
	z.strictObject({ type: z.literal("integer"), value: z.number().int() }),
	z.strictObject({ type: z.literal("boolean"), value: z.boolean() }),
	z.strictObject({ type: z.literal("instant"), value: z.string().datetime({ offset: true }) }),
]);
export type Typed = z.infer<typeof Typed>;
export const TrustedControl = z.object({
	connector: z.string().regex(/^[a-z0-9_]+$/),
	variant: z.enum(["present", "absent", "private", "suspended", "renamed", "regional"]),
	by: z.enum(["email", "phone", "username", "handle"]),
	found: z.boolean(),
	value: z.string().min(1),
	region: z.string().nullable(),
	subject: z.object({ field: z.string().min(1), value: z.string().min(1) }).nullable(),
	expected: z.record(z.string(), Typed),
	provenance: z.object({ kind: z.enum(["published_account", "accounts_mcp", "supplied_control", "declared_control"]), source: z.string().min(1) }),
	verified_at: z.string().datetime({ offset: true }),
	fresh_until: z.string().datetime({ offset: true }),
	stale: z.boolean(),
	written_by: z.string().min(1),
	written_role: z.string(),
	rev: z.number().int().positive(),
});
export type TrustedControl = z.infer<typeof TrustedControl>;
export const TrustedControls = z.object({ connector: z.string(), controls: z.array(TrustedControl) });

export function pinControls(connector: string, controls: TrustedControl[], now = Date.now()): TrustedControl[] {
	if (controls.some((c) => c.connector !== connector || c.written_role !== "operator"))
		throw new FactoryBlocked("A trusted control must be written by the operator for this connector", "untrusted_control");
	if (controls.some((c) => c.stale || Date.parse(c.fresh_until) <= now))
		throw new FactoryBlocked(`A trusted control of ${connector} is past its freshness; re-verify it before probing`, "stale_control");
	if (!controls.some((c) => c.found && c.subject))
		throw new FactoryBlocked(`${connector} has no trusted control that finds an account`, "missing_trusted_control");
	return controls;
}

export function matches(expected: Typed, observed: string[] = []) {
	switch (expected.type) {
		case "text":
			return observed.includes(expected.value);
		case "integer":
			return observed.some((v) => /^-?\d+$/.test(v) && Number(v) === expected.value);
		case "boolean":
			return observed.includes(String(expected.value));
		case "instant":
			return observed.some((v) => Date.parse(v) === Date.parse(expected.value));
	}
}
