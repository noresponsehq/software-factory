import { execFileSync } from "node:child_process";
import { cpSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, expect, it } from "vitest";

let directory: string;
let binary: string;
beforeAll(() => {
	directory = mkdtempSync(join(tmpdir(), "nr-tmp-rpc-test-"));
	cpSync(new URL("./fixtures/probe-rpc", import.meta.url), directory, { recursive: true });
	cpSync(new URL("../sandbox/probe-rpc.go", import.meta.url), join(directory, "cmd/probe/factory_rpc.go"));
	binary = join(directory, "probe");
	execFileSync("go", ["build", "-buildvcs=false", "-o", binary, "./cmd/probe"], {
		cwd: directory,
		env: { ...process.env, GOTOOLCHAIN: "local", GOPROXY: "off", GOSUMDB: "off" },
		timeout: 60000,
		stdio: "pipe",
	});
}, 60000);
afterAll(() => { if (directory) rmSync(directory, { recursive: true, force: true }); });

it.each(["owner@example.invalid", "a&b@example.invalid", 'a"b@example.invalid', "ab", "true"])("redacts an identifier as data without corrupting JSON: %s", (value) => {
	const output = execFileSync(binary, ["lookup", "github"], { input: JSON.stringify({ by: "email", value }), encoding: "utf8" });
	const result = JSON.parse(output);
	expect(result.found).toBe(true);
	expect(result.values.identifier).toEqual(["[redacted]"]);
	expect(result.values.id).toEqual(["independent-id-9"]);
	expect(result.sources).toEqual(["https://example.invalid/profile/[redacted]"]);
	expect(result).not.toHaveProperty("cause");
});
it("preserves the network failure classification without private cause text", () => {
	const output = execFileSync(binary, ["lookup", "github"], { input: JSON.stringify({ by: "email", value: "network_failure_fixture" }), encoding: "utf8" });
	expect(JSON.parse(output)).toEqual({ found: false, fields: [], error: "unavailable", took_ms: 0 });
});
it("supplies the private policy command independently of the public CLI", () => {
	expect(JSON.parse(execFileSync(binary, ["policy"], { encoding: "utf8" }))).toEqual({ trials: 5, admitted_ms: 5000 });
});
