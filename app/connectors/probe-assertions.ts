import { z } from "zod";
import { FactoryBlocked, FactoryFailure } from "./failure.js";

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
	sources: z.array(z.string()).optional(),
	error: z.string().max(100).optional(),
	took_ms: z.number().nonnegative(),
});
export async function assertProbe(control: Control, lookup: (value: string, network: boolean) => Promise<{ output: unknown; elapsedMs: number }>) {
	const known = control.known;
	if (known.Supplied || known.Paid || !known.Present || (!known.PresentOnly && !known.Absent))
		throw new FactoryBlocked("Trusted supplied control or paid lookup allowance is missing");
	let checks = 0;
	const times: number[] = [];
	for (const [value, found] of [[known.Present, true], ...(known.PresentOnly ? [] : [[known.Absent, false]])] as [string, boolean][]) {
		for (let attempt = 0; attempt < control.trials; attempt++) {
			const response = await lookup(value, true);
			const reading = Reading.parse(response.output);
			if (reading.error || reading.found !== found || (found && known.Fields.some((field) => !reading.fields.includes(field))))
				throw new FactoryFailure("probe", { status: "fail", reason: "trusted_control_assertion", checks, failed: 1, skipped: 0 });
			times.push(response.elapsedMs);
			checks++;
		}
	}
	const denied = Reading.parse((await lookup(known.Present, false)).output);
	if (!denied.error || denied.found)
		throw new FactoryFailure("probe", { status: "fail", reason: "network_failure_was_not_an_error", checks, failed: 1, skipped: 0 });
	checks++;
	const p95 = times.sort((a, b) => a - b)[Math.ceil(times.length * 0.95) - 1];
	if (p95 > control.admitted_ms)
		throw new FactoryFailure("probe", { status: "fail", reason: "host_measured_latency", checks, failed: 1, skipped: 0 });
	return { status: "pass", checks, failed: 0, skipped: 0, trials: control.trials, p95_ms: p95, verdict_owner: "trusted_host" };
}
