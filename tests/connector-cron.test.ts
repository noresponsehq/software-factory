import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import ts from "typescript";
import { expect, it, vi } from "vitest";

vi.mock("../factory.config.js", async () => ({
	default: {
		...(await import("./fixtures/config.js")).testConfig,
		connectors: { marker: "factory:connector", dailyUsd: 50, reserveUsd: 8, toolAllowanceUsd: 0.5 },
	},
}));

import { ENV_GROUPS, SECRET_ENV, SERVICE_ENV } from "../scripts/lib/requirements.js";

it("keeps the optional residential proxy secret only in the workflows group", () => {
	const key = "NR_PROBE_PROXIES_RESIDENTIAL";
	expect(ENV_GROUPS.filter((group) => [...group.keys, ...(group.optionalKeys ?? [])].includes(key)).map((group) => group.services)).toEqual([["workflows"]]);
	expect(SECRET_ENV).toContain(key);
});

it("schedules bounded UTC intake with only dispatch and intake credential groups", () => {
	const yaml = readFileSync(new URL("../render.yaml", import.meta.url), "utf8");
	const cron = yaml.slice(yaml.indexOf("          - type: cron"));
	expect(cron).toContain("name: factory-intake");
	expect(cron).toContain('schedule: "*/5 * * * *"');
	expect(cron).toContain("startCommand: timeout --kill-after=5s 180 node --import tsx scripts/connector-intake.ts");
	const groups = [...cron.matchAll(/fromGroup: ([a-z-]+)/g)].map((m) => m[1]);
	expect(groups).toEqual(["software-factory-shared", "software-factory-intake"]);
	expect(cron).toContain("key: RENDER_WORKFLOW_SLUG");
	const secrets = groups.flatMap((name) => ENV_GROUPS.find((g) => g.name === name)?.keys ?? []);
	expect(secrets.sort()).toEqual(
		[
			"RENDER_API_KEY",
			"NR_LEDGER_URL",
			"NR_FACTORY_OPERATOR_TOKEN",
			"LINEAR_API_KEY",
			"GITHUB_APP_ID",
			"GITHUB_APP_PRIVATE_KEY",
			"FACTORY_GITHUB_INSTALLATION_ID",
			"FACTORY_ACTOR",
			"FACTORY_LINEAR_ASSIGNEE",
			"FACTORY_LINEAR_TEAM",
		].sort(),
	);
	expect(SERVICE_ENV.intake).toEqual(expect.arrayContaining(secrets));
	expect(secrets.join(" ")).not.toMatch(/CLAUDE|ANTHROPIC|FLY|PROD/);
});
it("intake has no candidate or model execution dependency and admits daily costs before dispatch", () => {
	const entry = resolve("scripts/connector-intake.ts");
	const source = readFileSync(entry, "utf8");
	expect(source.indexOf("await accountDaily()")).toBeGreaterThan(0);
	expect(source.indexOf("await accountDaily()")).toBeLessThan(source.indexOf("await intake("));
	const seen = new Set<string>();
	function visit(path: string) {
		if (seen.has(path)) return;
		seen.add(path);
		const ast = ts.createSourceFile(path, readFileSync(path, "utf8"), ts.ScriptTarget.Latest, true);
		for (const statement of ast.statements) {
			if (
				(!ts.isImportDeclaration(statement) && !ts.isExportDeclaration(statement)) ||
				!statement.moduleSpecifier ||
				!ts.isStringLiteral(statement.moduleSpecifier)
			)
				continue;
			const spec = statement.moduleSpecifier.text;
			if (spec.startsWith(".")) visit(resolve(dirname(path), spec.replace(/\.js$/, ".ts")));
		}
	}
	visit(entry);
	expect([...seen].join("\n")).not.toMatch(/app\/(sandbox|runner|harness|agents|workflows)\/|connectors\/(runtime|claude|probe)\.ts/);
});
