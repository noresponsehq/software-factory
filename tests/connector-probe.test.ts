import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { describe, expect, it, vi } from "vitest";
import { assertProbe, type Control } from "../app/connectors/probe-assertions.js";

const control: Control = {
	known: { By: "username", Present: "present", Absent: "absent", Fields: ["name"], Supplied: false, Paid: false, PresentOnly: false },
	trials: 5,
	admitted_ms: 5000,
};
const reading = (found: boolean, error?: string) => ({ found, fields: found ? ["name"] : [], took_ms: 1, ...(error ? { error } : {}) });
describe("host-owned probe verdicts", () => {
	it("generates success only from positive, absent and isolated-network assertions", async () => {
		const lookup = vi.fn(async (value: string, network: boolean) => ({
			output: reading(network && value === "present", network ? undefined : "unavailable"),
			elapsedMs: 10,
		}));
		expect(await assertProbe(control, lookup)).toMatchObject({ status: "pass", checks: 11, verdict_owner: "trusted_host" });
		expect(lookup).toHaveBeenCalledWith("present", false);
	});
	it.each(["fabricated_verdict", "missing_field", "absent_found", "outage_as_absent", "slow"])("rejects %s candidate output", async (failure) => {
		const lookup = async (value: string, network: boolean) => ({
			output:
				failure === "fabricated_verdict"
					? { status: "pass", checks: 100, control: { verdict: "passed" } }
					: failure === "missing_field"
						? { ...reading(true), fields: [] }
						: failure === "absent_found"
							? reading(true)
							: failure === "outage_as_absent"
								? reading(network && value === "present")
								: reading(network && value === "present", network ? undefined : "unavailable"),
			elapsedMs: failure === "slow" ? 5001 : 10,
		});
		await expect(assertProbe(control, lookup)).rejects.toThrow();
	});
	it("requires a trusted supplied control source before any candidate lookup", async () => {
		const lookup = vi.fn();
		await expect(assertProbe({ ...control, known: { ...control.known, Supplied: true } }, lookup)).rejects.toThrow("Trusted supplied control");
		expect(lookup).not.toHaveBeenCalled();
	});
	it("pins AST controls and their referenced constants without executing candidate init", async () => {
		const dir = await mkdtemp(join(tmpdir(), "factory-control-test-"));
		const exec = promisify(execFile);
		try {
			const code = (present: string, answer: string) =>
				`package candidate\nimport c "github.com/noresponsehq/noresponse/apps/identity/internal/connector"\nconst present = "${present}"\nvar known = c.Known{Present: present, Absent: "absent"}\nfunc init(){ panic("candidate init must never run") }\nfunc Answer() string { return "${answer}" }\n`;
			const run = async (present: string, answer: string) => {
				await writeFile(join(dir, "candidate.go"), code(present, answer));
				return (await exec("go", ["run", resolve("sandbox/control-pin.go"), dir], { timeout: 60000 })).stdout;
			};
			const original = await run("present", "old");
			expect(await run("present", "new")).toBe(original);
			expect(await run("changed", "new")).not.toBe(original);
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	}, 60000);
});
