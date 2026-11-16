import { z } from "zod";
import { FactoryBlocked, FactoryFailure } from "./failure.js";
import { matches, type TrustedControl } from "./trusted-controls.js";

export const Control = z.object({
	known: z.object({
		By: z.string().min(1),
		Present: z.string(),
		Absent: z.string(),
		Fields: z
			.array(z.string())
			.nullable()
			.transform((value) => value ?? []),
		Supplied: z.boolean(),
		PresentOnly: z.boolean(),
		Paid: z.boolean(),
	}),
	trials: z.number().int().min(5).max(10),
	admitted_ms: z.number().int().positive(),
});
export type Control = z.infer<typeof Control>;
const Reading = z.strictObject({
	found: z.boolean(),
	fields: z.array(z.string().max(100)).max(1000),
	values: z.record(z.string().max(100), z.array(z.string().max(10000)).max(1000)).optional(),
	sources: z.array(z.string()).optional(),
	error: z.string().max(100).optional(),
	took_ms: z.number().nonnegative(),
});
type Case = Pick<TrustedControl, "value" | "found" | "subject" | "expected"> & { rev?: number };

function casesOf(control: Control, trusted: TrustedControl[]): Case[] {
	const known = control.known;
	if (known.Paid) throw new FactoryBlocked("Paid lookup allowance is missing", "paid_lookup_allowance");
	if (trusted.length) return trusted;
	if (known.Supplied || !known.Present || (!known.PresentOnly && !known.Absent))
		throw new FactoryBlocked("Trusted supplied control is missing from the ledger", "missing_trusted_control");
	return [
		{ value: known.Present, found: true, subject: null, expected: {} },
		...(known.PresentOnly ? [] : [{ value: known.Absent, found: false, subject: null, expected: {} }]),
	];
}

export async function assertProbe(
	control: Control,
	lookup: (value: string, network: boolean) => Promise<{ output: unknown; elapsedMs: number }>,
	trusted: TrustedControl[] = [],
) {
	const cases = casesOf(control, trusted);
	let checks = 0;
	const times: number[] = [];
	const fail = (reason: string, extra: Record<string, unknown> = {}) =>
		new FactoryFailure("probe", "product_failure", { status: "fail", reason, checks, failed: 1, skipped: 0, ...extra });
	for (const c of cases) {
		for (let attempt = 0; attempt < control.trials; attempt++) {
			const response = await lookup(c.value, true);
			const reading = Reading.parse(response.output);
			if (reading.error || reading.found !== c.found) throw fail("trusted_control_assertion");
			if (c.found && control.known.Fields.some((field) => !reading.fields.includes(field))) throw fail("trusted_control_assertion");
			if (c.subject && !reading.values?.[c.subject.field]?.includes(c.subject.value)) throw fail("subject_mismatch", { field: c.subject.field });
			const wrong = Object.entries(c.expected).find(([field, expected]) => !matches(expected, reading.values?.[field]));
			if (wrong) throw fail("value_mismatch", { field: wrong[0] });
			times.push(response.elapsedMs);
			checks++;
		}
	}
	const found = cases.find((c) => c.found) as Case;
	const denied = Reading.parse((await lookup(found.value, false)).output);
	if (!denied.error || denied.found) throw fail("network_failure_was_not_an_error");
	checks++;
	const p95 = times.sort((a, b) => a - b)[Math.ceil(times.length * 0.95) - 1];
	if (p95 > control.admitted_ms) throw fail("host_measured_latency");
	return {
		status: "pass",
		checks,
		failed: 0,
		skipped: 0,
		trials: control.trials,
		p95_ms: p95,
		control_revs: cases.flatMap((c) => (c.rev === undefined ? [] : [c.rev])),
		verdict_owner: "trusted_host",
	};
}
