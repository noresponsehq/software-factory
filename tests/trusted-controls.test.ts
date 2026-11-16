import { describe, expect, it, vi } from "vitest";
import { FactoryBlocked, FactoryFailure } from "../app/connectors/failure.js";
import { Ledger } from "../app/connectors/ledger.js";
import { assertProbe, type Control } from "../app/connectors/probe-assertions.js";
import { affectedConnectors, changeScope } from "../app/connectors/trusted-build.js";
import { pinControls, type TrustedControl } from "../app/connectors/trusted-controls.js";

const NOW = Date.parse("2026-11-17T12:00:00Z");
const control: Control = {
	known: { By: "email", Present: "", Absent: "", Fields: ["name"], Supplied: true, Paid: false, PresentOnly: false },
	trials: 5,
	admitted_ms: 5000,
};
const trusted = (over: Partial<TrustedControl> = {}): TrustedControl => ({
	connector: "gravatar",
	variant: "present",
	by: "email",
	found: true,
	value: "owner@example.org",
	region: null,
	subject: { field: "id", value: "12345" },
	expected: { username: { type: "text", value: "owner" }, followers: { type: "integer", value: 7 } },
	provenance: { kind: "accounts_mcp", source: "acct_1" },
	verified_at: "2026-11-17T11:00:00.000Z",
	fresh_until: "2026-12-17T11:00:00.000Z",
	stale: false,
	written_by: "harry",
	written_role: "operator",
	rev: 41,
	...over,
});
const absent = trusted({ variant: "absent", found: false, value: "nr-known-absent-q7@example.org", subject: null, expected: {}, rev: 42 });
const observed = (values: Record<string, string[]>) => ({ found: true, fields: Object.keys(values), values, took_ms: 1 });
const honest = async (value: string, network: boolean) => ({
	output: !network
		? { found: false, fields: [], error: "unavailable", took_ms: 1 }
		: value === "owner@example.org"
			? observed({ id: ["12345"], username: ["owner"], followers: ["7"], name: ["Owner"] })
			: { found: false, fields: [], took_ms: 1 },
	elapsedMs: 10,
});
const reasonOf = async (promise: Promise<unknown>) => {
	try {
		await promise;
	} catch (error) {
		if (error instanceof FactoryFailure) return error.payload.reason;
		if (error instanceof FactoryBlocked) return error.reason;
		throw error;
	}
	return "passed";
};

describe("trusted controls from the ledger", () => {
	it("reads controls with the operator bearer and never from the candidate", async () => {
		const request = vi.fn(async () => Response.json({ connector: "gravatar", controls: [trusted(), absent] }));
		const controls = await new Ledger("https://ledger.test", "operator-token", request as unknown as typeof fetch).controls("gravatar");
		expect(controls).toHaveLength(2);
		expect(request).toHaveBeenCalledWith(
			"https://ledger.test/ledger/controls/gravatar",
			expect.objectContaining({ method: "GET", headers: expect.objectContaining({ Authorization: "Bearer operator-token" }) }),
		);
	});
	it("refuses a control that an agent or any role but the operator wrote", async () => {
		expect(await reasonOf(Promise.resolve().then(() => pinControls("gravatar", [trusted({ written_role: "agent" }), absent], NOW)))).toBe(
			"untrusted_control",
		);
	});
	it("blocks a stale control with a typed reason", async () => {
		expect(await reasonOf(Promise.resolve().then(() => pinControls("gravatar", [trusted({ stale: true }), absent], NOW)))).toBe("stale_control");
		expect(
			await reasonOf(Promise.resolve().then(() => pinControls("gravatar", [trusted({ fresh_until: "2026-11-17T11:59:59.000Z" }), absent], NOW))),
		).toBe("stale_control");
	});
	it("blocks when no trusted control finds an account", async () => {
		expect(await reasonOf(Promise.resolve().then(() => pinControls("gravatar", [absent], NOW)))).toBe("missing_trusted_control");
	});
	it("admits a supplied control once the ledger supplies it, and checks subject and typed values", async () => {
		const pinned = pinControls("gravatar", [trusted(), absent], NOW);
		expect(await assertProbe(control, honest, pinned)).toMatchObject({
			status: "pass",
			checks: 11,
			control_revs: [41, 42],
			verdict_owner: "trusted_host",
		});
	});
	it("fails a value mismatch and a subject mismatch even when every field is present", async () => {
		const pinned = pinControls("gravatar", [trusted(), absent], NOW);
		const answering = (values: Record<string, string[]>) => async (value: string, network: boolean) =>
			value === "owner@example.org" && network ? { output: observed(values), elapsedMs: 10 } : honest(value, network);
		expect(
			await reasonOf(assertProbe(control, answering({ id: ["12345"], username: ["someone_else"], followers: ["7"], name: ["O"] }), pinned)),
		).toBe("value_mismatch");
		expect(await reasonOf(assertProbe(control, answering({ id: ["12345"], username: ["owner"], followers: ["8"], name: ["O"] }), pinned))).toBe(
			"value_mismatch",
		);
		expect(await reasonOf(assertProbe(control, answering({ id: ["99999"], username: ["owner"], followers: ["7"], name: ["O"] }), pinned))).toBe(
			"subject_mismatch",
		);
		expect(await reasonOf(assertProbe(control, answering({ username: ["owner"], followers: ["7"], name: ["O"] }), pinned))).toBe("subject_mismatch");
	});
	it("still blocks a supplied control with no trusted control before any lookup", async () => {
		const lookup = vi.fn();
		expect(await reasonOf(assertProbe(control, lookup))).toBe("missing_trusted_control");
		expect(lookup).not.toHaveBeenCalled();
	});
	it("records an input-echo subject as unchecked while retaining found and independent-value assertions", async () => {
		const echo = trusted({ subject: { field: "email", value: "owner@example.org" }, expected: { email: { type: "text", value: "owner@example.org" }, id: { type: "text", value: "12345" } } });
		const lookup = async (value: string, network: boolean) => value === echo.value && network
			? { output: observed({ email: ["[redacted]"], id: ["12345"], username: ["owner"], followers: ["7"], name: ["O"] }), elapsedMs: 1 }
			: honest(value, network);
		const result = await assertProbe(control, lookup, pinControls("gravatar", [echo, absent], NOW));
		expect(result).toMatchObject({ status: "pass", unchecked: [{ field: "email", control_rev: 41, reason: "input_echo" }] });
		expect(JSON.stringify(result)).not.toContain(echo.value);
		const wrong = async (value: string, network: boolean) => value === echo.value && network
			? { output: observed({ email: ["[redacted]"], id: ["wrong"], username: ["owner"], followers: ["7"], name: ["O"] }), elapsedMs: 1 }
			: honest(value, network);
		expect(await reasonOf(assertProbe(control, wrong, [echo, absent]))).toBe("value_mismatch");
	});
});

describe("shared adapter recipe", () => {
	it("scopes a change to one connector folder as that connector", () => {
		expect(changeScope(["apps/identity/internal/connectors/github/github.go"], "github")).toEqual({
			kind: "connector",
			packages: ["apps/identity/internal/connectors/github"],
		});
	});
	it("scopes a shared Go change as its packages instead of blocking it", () => {
		expect(
			changeScope(
				["apps/identity/internal/cookies/parse.go", "apps/identity/internal/cookies/parse_test.go", "apps/identity/internal/connectors/x_email/x.go"],
				"x_email",
			),
		).toEqual({ kind: "shared", packages: ["apps/identity/internal/connectors/x_email", "apps/identity/internal/cookies"] });
	});
	it("still refuses changes to the trusted harness, the generated registry, workflows or files outside Identity's Go packages", () => {
		for (const path of [
			"apps/identity/cmd/probe/main.go",
			".github/workflows/ci.yml",
			"apps/identity/go.mod",
			"apps/identity/internal/cookies/fixture.json",
			"apps/identity/internal/../x.go",
		])
			expect(() => changeScope([path, "apps/identity/internal/cookies/parse.go"], "x_email")).toThrow();
	});
	it("selects every connector whose package depends on a changed package", () => {
		const module = "github.com/noresponsehq/noresponse/apps/identity";
		const listing = [
			`${module}/internal/connectors/x_email ${module}/internal/cookies ${module}/internal/connector`,
			`${module}/internal/connectors/github ${module}/internal/connector`,
			`${module}/internal/whatsapp ${module}/internal/cookies`,
			`${module}/internal/cookies ${module}/internal/connector`,
			`${module}/internal/connectors ${module}/internal/emailaccount`,
		].join("\n");
		const ids = ["x_email", "github", "whatsapp", "amazon"];
		expect(affectedConnectors(listing, ids, ["apps/identity/internal/cookies"], "x_email")).toEqual(["whatsapp", "x_email"]);
		expect(affectedConnectors(listing, ids, ["apps/identity/internal/emailaccount"], "x_email")).toEqual(["amazon", "x_email"]);
		expect(affectedConnectors(listing, ids, ["apps/identity/internal/connectors/github"], "github")).toEqual(["github"]);
	});
});
