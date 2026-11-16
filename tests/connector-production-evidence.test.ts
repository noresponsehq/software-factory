import { expect, it } from "vitest";
import { productionFailure } from "../app/connectors/production-evidence.js";

it("retains actual failing check counts and exit without exporting raw identifiers or messages", () => {
	const summary = {
		gaps: ["sensitive gap"],
		harness: { steps: [{ ok: true }] },
		providers: { search: { steps: [{ ok: false, email: "private@example.test" }, { ok: false }] } },
	};
	const receipt = productionFailure("production_smoke", { code: 3, stderr: "secret" }, summary);
	expect(receipt).toEqual({
		status: "fail",
		stage: "production_smoke",
		exit_code: 3,
		termination_signal: null,
		checks: 3,
		failed: 2,
		skipped: 1,
		summary_available: true,
	});
	expect(JSON.stringify(receipt)).not.toMatch(/private|secret|sensitive/);
});
it("reports missing counts as unknown and never invents successful zeros", () => {
	expect(productionFailure("fetch_operator", { code: "ENOTFOUND", message: "secret" }, null)).toMatchObject({
		checks: null,
		failed: null,
		skipped: null,
		exit_code: null,
		summary_available: false,
	});
	expect(productionFailure("production_smoke", { signal: "SIGKILL" }, {})).toMatchObject({ termination_signal: "SIGKILL" });
});
