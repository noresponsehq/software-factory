import { describe, expect, it, vi } from "vitest";
import { AcceptanceRecipe, resolveFixture } from "../app/connectors/acceptance.js";
import type { TrustedControl } from "../app/connectors/trusted-controls.js";

const now = Date.parse("2026-11-17T00:00:00Z");
const identifier = "synthetic@example.invalid";
const control: TrustedControl = {
	connector: "firefox_email", variant: "present", rev: 42, by: "email", found: true, value: identifier,
	region: null, subject: { field: "email", value: identifier }, expected: {},
	provenance: { kind: "supplied_control", source: "offline" }, verified_at: "2026-11-16T00:00:00Z",
	fresh_until: "2026-12-16T00:00:00Z", stale: false, written_by: "operator", written_role: "operator",
};
const recipe = AcceptanceRecipe.parse({
	connector: "firefox_email", behaviour: "look up an owned account", fixtures: [{ ref: "control.present", identifier: "email", control: { connector: "firefox_email", variant: "present", rev: 42 } }],
	requires: { session: false, route: null }, operation: { kind: "group_person_lookup", fixture: "control.present" },
	expect: { execution: "found", fields: ["email"] }, observe: { ledger_revision: 40 }, uncovered: [],
});
describe("sealed production fixtures", () => {
	it("resolves exactly the pinned operator control without putting its value into the recipe", async () => {
		const before = JSON.stringify(recipe);
		const read = vi.fn(async () => [control]);
		expect(await resolveFixture(recipe, read, () => now)).toEqual({ email: identifier });
		expect(read).toHaveBeenCalledWith("firefox_email");
		expect(JSON.stringify(recipe)).toBe(before);
		expect(before).not.toContain(identifier);
	});
	it.each([
		{ rev: 43 }, { variant: "absent" }, { connector: "another" }, { stale: true }, { fresh_until: "2026-11-16T00:00:00Z" },
		{ written_role: "engine" }, { by: "phone" }, { found: false },
	])("refuses mismatched or stale control %j without retaining identifiers", async (change) => {
		try {
			await resolveFixture(recipe, async () => [{ ...control, ...change }], () => now);
			throw new Error("expected refusal");
		} catch (error) {
			expect(error).toMatchObject({ payload: { reason: "fixture_unresolved", fixture: "control.present" } });
			expect(JSON.stringify(error)).not.toContain(identifier);
		}
	});
	it.each([{ rows: [] }, { rows: [control, control] }, { rows: [{ value: identifier }] }])("refuses missing, duplicate or malformed controls", async ({ rows }) => {
		await expect(resolveFixture(recipe, async () => rows, () => now)).rejects.toMatchObject({ payload: { reason: "fixture_unresolved" } });
	});
	it("rejects a foreign connector reference before reading any control", async () => {
		const read = vi.fn();
		const foreign = AcceptanceRecipe.parse({ ...recipe, fixtures: [{ ...recipe.fixtures[0], control: { connector: "other", variant: "present", rev: 42 } }] });
		await expect(resolveFixture(foreign, read, () => now)).rejects.toMatchObject({ payload: { reason: "fixture_unresolved" } });
		expect(read).not.toHaveBeenCalled();
	});
	it("allows a pinned absent control only for expected not_found", async () => {
		const absent = AcceptanceRecipe.parse({ ...recipe, fixtures: [{ ...recipe.fixtures[0], control: { connector: "firefox_email", variant: "absent", rev: 42 } }], expect: { execution: "not_found", fields: [] } });
		expect(await resolveFixture(absent, async () => [{ ...control, variant: "absent", found: false, subject: null }], () => now)).toEqual({ email: identifier });
	});
	it("keeps public username fixtures and refuses raw email or phone values", async () => {
		const read = vi.fn();
		const publicRecipe = AcceptanceRecipe.parse({ ...recipe, fixtures: [{ ref: "control.present", identifier: "username", platform: "github", value: "octocat" }] });
		expect(await resolveFixture(publicRecipe, read, () => now)).toEqual({ handles: [{ platform: "github", handle: "octocat" }] });
		expect(read).not.toHaveBeenCalled();
		for (const kind of ["email", "phone"])
			expect(AcceptanceRecipe.safeParse({ ...recipe, fixtures: [{ ref: "control.present", identifier: kind, value: identifier }] }).success).toBe(false);
	});
	it("does not propagate a transport error containing the identifier", async () => {
		await expect(resolveFixture(recipe, async () => { throw new Error(identifier); }, () => now)).rejects.toMatchObject({ message: "Factory production failed", payload: { reason: "fixture_unresolved" } });
	});
});
