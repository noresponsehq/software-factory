import { z } from "zod";
import type { FailureClass, VerificationBundle } from "./bundle.js";
import { FactoryFailure } from "./failure.js";
import { TrustedControl } from "./trusted-controls.js";

const sha = z.string().regex(/^[a-f0-9]{40}$/);
const name = z
	.string()
	.regex(/^[a-z0-9_]+$/)
	.max(100);

// The recipe lives at this path in the merged commit, so it is reviewed with the change and cannot be edited after merge.
export const recipePath = (connector: string) => `apps/identity/internal/connectors/${name.parse(connector)}/acceptance.json`;

export const ControlReference = z.strictObject({
	connector: name,
	variant: TrustedControl.shape.variant,
	rev: z.number().int().positive(),
});
const Fixture = z.union([
	z.strictObject({ ref: z.string().regex(/^[A-Za-z0-9_.-]{1,100}$/), identifier: z.literal("username"), platform: name.optional(), value: z.string().min(1).max(320) }),
	z.strictObject({ ref: z.string().regex(/^[A-Za-z0-9_.-]{1,100}$/), identifier: z.enum(["email", "phone", "username"]), control: ControlReference }),
]);

export const AcceptanceRecipe = z.strictObject({
	connector: name,
	behaviour: z.string().min(1).max(500),
	fixtures: z.array(Fixture).min(1).max(5),
	requires: z.strictObject({ session: z.boolean(), route: z.string().min(1).max(200).nullable() }),
	operation: z.strictObject({ kind: z.literal("group_person_lookup"), fixture: z.string().min(1).max(100) }),
	expect: z.strictObject({
		execution: z.enum(["found", "not_found"]),
		fields: z.array(z.string().min(1).max(100)).max(50),
	}),
	observe: z.strictObject({ ledger_revision: z.number().int().nonnegative() }),
	uncovered: z.array(z.string().min(1).max(300)).max(20),
});
export type AcceptanceRecipe = z.infer<typeof AcceptanceRecipe>;

export async function resolveFixture(recipe: AcceptanceRecipe, read: (connector: string) => Promise<unknown>, now = Date.now()) {
	const fixture = recipe.fixtures.find((f) => f.ref === recipe.operation.fixture);
	const refused = () => proofFailure("fixture_unresolved", { fixture: recipe.operation.fixture });
	if (!fixture) throw refused();
	let value: string;
	if ("control" in fixture) {
		if (fixture.control.connector !== recipe.connector) throw refused();
		try {
			const controls = z.array(TrustedControl).parse(await read(recipe.connector));
			const selected = controls.filter((c) => c.connector === recipe.connector && c.variant === fixture.control.variant && c.rev === fixture.control.rev);
			if (selected.length !== 1) throw refused();
			const control = selected[0] as TrustedControl;
			if (control.stale || Date.parse(control.fresh_until) <= now || control.written_role !== "operator" ||
				(control.by === "handle" ? "username" : control.by) !== fixture.identifier || control.found !== (recipe.expect.execution === "found")) throw refused();
			value = control.value;
		} catch {
			throw refused();
		}
	} else value = fixture.value;
	return fixture.identifier === "username"
		? { handles: [{ platform: "platform" in fixture ? fixture.platform ?? recipe.connector : recipe.connector, handle: value }] }
		: { [fixture.identifier]: value };
}

export type ProofReason =
	| "acceptance_recipe_missing"
	| "fixture_unresolved"
	| "connector_not_executed"
	| "connector_unanswered"
	| "fields_missing"
	| "ledger_revision_not_observed"
	| "stale_build"
	| "production_kept_moving";

const PROOF_CLASS: Record<ProofReason, FailureClass> = {
	acceptance_recipe_missing: "missing_prerequisite",
	fixture_unresolved: "missing_prerequisite",
	connector_not_executed: "product_failure",
	connector_unanswered: "product_failure",
	fields_missing: "product_failure",
	ledger_revision_not_observed: "environment_failure",
	stale_build: "superseded_release",
	production_kept_moving: "superseded_release",
};

export function proofFailure(reason: ProofReason, detail: Record<string, unknown> = {}): FactoryFailure {
	const failure = PROOF_CLASS[reason];
	return new FactoryFailure("production", failure, { status: "fail", stage: "acceptance", reason, failure_class: failure, ...detail });
}

const Lookup = z.object({
	checks: z.array(
		z.object({
			identifier: z.string(),
			status: z.string(),
			answered: z.number().int().nonnegative(),
			unanswered: z.array(z.object({ connector: z.string(), reason: z.string() })).default([]),
		}),
	),
	records: z.array(z.object({ source: z.object({ connector: z.string() }), fields: z.array(z.object({ field: z.string() })) })).default([]),
});

export function proveBehaviour(recipe: AcceptanceRecipe, rawLookup: unknown) {
	const lookup = Lookup.safeParse(rawLookup);
	if (!lookup.success) throw proofFailure("connector_not_executed", { connector: recipe.connector, detail: "no completed lookup" });
	const fixture = recipe.fixtures.find((f) => f.ref === recipe.operation.fixture);
	if (!fixture) throw proofFailure("fixture_unresolved", { fixture: recipe.operation.fixture });
	const lanes = lookup.data.checks.filter((check) => check.identifier === fixture.identifier);
	const unanswered = lanes.flatMap((lane) => lane.unanswered).find((miss) => miss.connector === recipe.connector);
	if (unanswered) throw proofFailure("connector_unanswered", { connector: recipe.connector, source_reason: unanswered.reason });
	const records = lookup.data.records.filter((record) => record.source.connector === recipe.connector);
	if (recipe.expect.execution === "not_found") {
		if (records.length) throw proofFailure("connector_not_executed", { connector: recipe.connector, detail: "expected not_found, connector found" });
		if (!lanes.some((lane) => lane.answered > 0))
			throw proofFailure("connector_not_executed", { connector: recipe.connector, detail: "no source answered the lane" });
		return { connector: recipe.connector, execution: "not_found" as const, records: 0, fields: [] as string[] };
	}
	if (!records.length) throw proofFailure("connector_not_executed", { connector: recipe.connector, detail: "no record from connector" });
	const seen = new Set(records.flatMap((record) => record.fields.map((field) => field.field)));
	const missing = recipe.expect.fields.filter((field) => !seen.has(field));
	if (missing.length) throw proofFailure("fields_missing", { connector: recipe.connector, missing });
	return { connector: recipe.connector, execution: "found" as const, records: records.length, fields: recipe.expect.fields };
}

export type Revisions = { api: number | null; worker: number | null };
export async function awaitLedgerRevision(
	read: () => Promise<Revisions>,
	required: number,
	clock: { now: () => number; sleep: (ms: number) => Promise<void>; timeoutMs: number; intervalMs: number },
) {
	const deadline = clock.now() + clock.timeoutMs;
	let last: Revisions = { api: null, worker: null };
	for (;;) {
		try {
			last = await read();
		} catch {
			last = { api: null, worker: null };
		}
		if (last.api !== null && last.worker !== null && last.api >= required && last.worker >= required) return last;
		if (clock.now() >= deadline) throw proofFailure("ledger_revision_not_observed", { required, api: last.api, worker: last.worker });
		await clock.sleep(clock.intervalMs);
	}
}

export type SmokeProof = {
	operator_sha: string;
	selection: string;
	exit_code: number;
	status: string;
	checks: number;
	failed: number;
	skipped: number;
	bundle: VerificationBundle;
};
export type ProofPorts = {
	version: () => Promise<string>;
	contains: (older: string, newer: string) => Promise<boolean>;
	revisions: () => Promise<Revisions>;
	smoke: (build: string) => Promise<SmokeProof>;
	lookup: (recipe: AcceptanceRecipe) => Promise<unknown>;
	clock: { now: () => number; sleep: (ms: number) => Promise<void>; timeoutMs: number; intervalMs: number };
};

export async function proveRelease(requested: string, recipe: AcceptanceRecipe, ports: ProofPorts) {
	sha.parse(requested);
	const follow = async (expected: string) => {
		const observed = await ports.version();
		if (observed === expected) return observed;
		if (sha.safeParse(observed).success && (await ports.contains(expected, observed))) return observed;
		throw proofFailure("stale_build", { requested, expected, observed });
	};
	let build = await follow(requested);
	for (let attempt = 0; attempt < 3; attempt++) {
		const ledger = await awaitLedgerRevision(ports.revisions, recipe.observe.ledger_revision, ports.clock);
		const smoke = await ports.smoke(build);
		const behaviour = proveBehaviour(recipe, await ports.lookup(recipe));
		const after = await follow(build);
		if (after === build)
			return {
				sha: requested,
				release_state: build === requested ? ("exact" as const) : ("superseded" as const),
				requested,
				observed: build,
				ledger_revision: { required: recipe.observe.ledger_revision, api: ledger.api, worker: ledger.worker },
				behaviour,
				...smoke,
			};
		build = after;
	}
	throw proofFailure("production_kept_moving", { requested, observed: build });
}
