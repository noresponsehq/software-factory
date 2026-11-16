import { describe, expect, it, vi } from "vitest";

vi.mock("../factory.config.js", async () => {
	const { testConfig } = await import("./fixtures/config.js");
	return { default: { ...testConfig, connectors: { marker: "factory:connector", dailyUsd: 50, reserveUsd: 5, toolAllowanceUsd: 0.5 } } };
});

import { requireRepo } from "../app/config/index.js";
import { builderEgress, taskEgress } from "../app/sandbox/egress.js";
import { buildManifest, formPage } from "../scripts/lib/manifest.js";
import { LABELS, missingPermissions, SERVICE_ENV } from "../scripts/lib/requirements.js";

describe("connector deployment permissions", () => {
	it("requests and displays only the writes and reads the lifecycle needs", () => {
		const manifest = buildManifest({ name: "factory", redirectUrl: "http://127.0.0.1/callback" });
		expect(manifest.default_permissions).toEqual({
			contents: "write",
			issues: "write",
			pull_requests: "write",
			metadata: "read",
			actions: "read",
			checks: "read",
		});
		expect(manifest.description).toContain("release verification");
		expect(manifest.description).not.toContain("draft PR");
		const page = formPage(manifest, "https://github.com/new", ["noresponsehq/noresponse"]);
		expect(page).toContain("actions (read)");
		expect(page).toContain("checks (read)");
		expect(missingPermissions({ contents: "write", issues: "write", pull_requests: "write", metadata: "read" })).toEqual([
			"actions:read",
			"checks:read",
		]);
		expect(SERVICE_ENV.workflows).toContain("CLAUDE_CODE_OAUTH_TOKEN");
		expect(SERVICE_ENV.workflows).not.toContain("ANTHROPIC_API_KEY");
		expect(SERVICE_ENV.workflows).toContain("FACTORY_FLY_API_TOKEN");
		expect(SERVICE_ENV.workflows).not.toContain("FLY_API_TOKEN");
		expect(LABELS.map((label) => label.name)).toEqual(["factory:connector", "factory:working"]);
	});
	it("uses unrestricted networking for both connector builders and restored workloads", () => {
		const repo = requireRepo("acme/widget", 1);
		expect(builderEgress(repo)).toEqual({ type: "allow-all" });
		expect(taskEgress(repo)).toEqual({ type: "allow-all" });
	});
});
