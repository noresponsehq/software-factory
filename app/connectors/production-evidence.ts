import { z } from "zod";

const summarySchema = z.object({
	gaps: z.array(z.unknown()),
	harness: z.object({ steps: z.array(z.object({ ok: z.boolean() })) }),
	providers: z.object({ search: z.object({ steps: z.array(z.object({ ok: z.boolean() })) }) }),
});
export function productionFailure(stage: string, error: unknown, summary: unknown) {
	const parsed = summarySchema.safeParse(summary);
	const steps = parsed.success ? [...parsed.data.harness.steps, ...parsed.data.providers.search.steps] : null;
	const code = typeof error === "object" && error !== null && "code" in error ? error.code : null;
	const signal = typeof error === "object" && error !== null && "signal" in error ? error.signal : null;
	return {
		status: "fail",
		stage,
		exit_code: typeof code === "number" && Number.isInteger(code) ? code : null,
		termination_signal: signal === "SIGKILL" || signal === "SIGTERM" ? signal : null,
		checks: steps?.length ?? null,
		failed: steps?.filter((step) => !step.ok).length ?? null,
		skipped: parsed.success ? parsed.data.gaps.length : null,
		summary_available: parsed.success,
	};
}
