import { describe, expect, it, vi } from "vitest";
import { released } from "../app/connectors/release.js";
import { changeScope } from "../app/connectors/trusted-build.js";
import type { GitHubHttp } from "../app/github/index.js";

const head = "a".repeat(40);
describe("trusted connector validation", () => {
	it.each(["success", "failure"])("uses the deployment plan revision and %s release result", async (conclusion) => {
		const json = vi
			.fn()
			.mockResolvedValueOnce({ workflow_runs: [{ id: 1, head_sha: "b".repeat(40), status: "completed", conclusion, html_url: "https://release" }] })
			.mockResolvedValueOnce({
				jobs: [
					{ id: 2, name: "plan", status: "completed", conclusion: "success" },
					{ id: 3, name: "release", status: "completed", conclusion },
				],
			});
		const http = { json, text: vi.fn(async () => `running: old; candidate: ${head}; release: true`) } as unknown as GitHubHttp;
		expect((await released(http, "o/r", head)).status).toBe(conclusion === "success" ? "passed" : "failed");
		expect(json.mock.calls[0]?.[2]).toEqual({ query: { per_page: 100 } });
	});
	it("refuses candidate edits to the probe, shared assertions, and traversal", () => {
		for (const path of [
			"apps/identity/cmd/probe/main.go",
			"apps/identity/internal/connector/known_test.go",
			"apps/identity/internal/connectors/github/../other/x.go",
		])
			expect(() => changeScope([path], "github")).toThrow();
		expect(() => changeScope(["apps/identity/internal/connectors/github/github.go"], "github")).not.toThrow();
	});
});
