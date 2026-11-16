import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { checkDeployment } from "../scripts/lib/deployment.js";
import { type CheckResult, Reporter } from "../scripts/lib/output.js";

const API_KEY = "rnd_renderSECRETkey";
const ENV = { RENDER_API_KEY: API_KEY, RENDER_WORKSPACE_ID: "tea-cufunlhopnds73b9966g" };
const DEPLOYED = "a555c7ca53fe04280254e6b11ca68d1bc2d8d26f";
const INTENDED = "0123456789abcdef0123456789abcdef01234567";

const recorded = (name: string) => readFileSync(new URL(`fixtures/render-deployment/${name}`, import.meta.url), "utf8");

type Route = { status?: number; body: string };

function renderApi(overrides: Record<string, Route> = {}) {
	const routes: Record<string, Route> = {
		"GET /v1/workflows": { body: recorded("workflows.json") },
		"GET /v1/workflowversions": { body: recorded("workflowversions.json") },
		"GET /v1/tasks": { body: recorded("tasks.json") },
		"GET /v1/services?factory-gateway": { body: recorded("services-factory-gateway.json") },
		"GET /v1/services?factory-intake": { body: recorded("services-factory-intake.json") },
		"POST /v1/task-runs": { status: 404, body: recorded("task-run-missing.txt").replace(/\s*\[404\]\s*$/, "") },
		...overrides,
	};
	const deploys: Record<string, string> = {};
	for (const name of ["factory-gateway", "factory-intake"]) {
		const [row] = JSON.parse(routes[`GET /v1/services?${name}`]?.body ?? "[]") as { service: { id: string } }[];
		if (row) deploys[row.service.id] = routes[`GET /v1/deploys?${name}`]?.body ?? recorded(`deploys-${name}.json`);
	}
	return (async (input: string | URL | Request, init?: RequestInit) => {
		const url = new URL(String(input));
		const method = init?.method ?? "GET";
		const service = url.pathname.match(/^\/v1\/services\/([^/]+)\/deploys$/)?.[1];
		const key = url.pathname === "/v1/services" ? `GET /v1/services?${url.searchParams.get("name")}` : `${method} ${url.pathname}`;
		const route = service ? (deploys[service] ? { body: deploys[service] } : undefined) : routes[key];
		if (!route) return new Response('{"message":"not found"}', { status: 404 });
		return new Response(route.body, { status: route.status ?? 200, headers: { "content-type": "application/json" } });
	}) as typeof fetch;
}

async function check(revision: string, overrides?: Record<string, Route>) {
	const lines: string[] = [];
	const out = new Reporter((line) => lines.push(line));
	await checkDeployment({ env: ENV, revision, fetch: renderApi(overrides), sleep: async () => {} }, out);
	const find = (level: CheckResult["level"], text: string) => out.results.find((r) => r.level === level && r.message.includes(text));
	const output = lines.join("\n");
	expect(output).not.toContain(API_KEY);
	return { find, failed: out.results.filter((r) => r.level === "fail"), output };
}

describe("doctor --live against recorded Render responses", () => {
	it("names every mismatch when Render runs an older revision without the doctor task", async () => {
		const { find, failed } = await check(INTENDED);
		expect(find("fail", "factory-workflows runs a555c7c, not 0123456")).toBeDefined();
		expect(find("fail", "tasks not registered on version a555c7c: doctor")).toBeDefined();
		expect(find("fail", "factory-gateway runs a555c7c, not 0123456")).toBeDefined();
		expect(find("fail", "factory-intake runs a555c7c, not 0123456")).toBeDefined();
		expect(find("fail", "in-service probe did not run: Render answered 404 for POST /v1/task-runs")).toBeDefined();
		expect(find("warn", "factory-intake is suspended")).toBeDefined();
		expect(failed).toHaveLength(5);
	});

	it("matches the revision the services run but still fails the missing task and probe", async () => {
		const { find, failed } = await check(DEPLOYED);
		expect(find("pass", "factory-workflows runs a555c7c")).toBeDefined();
		expect(find("pass", "factory-gateway runs a555c7c")).toBeDefined();
		expect(failed.map((r) => r.message)).toEqual([
			"tasks not registered on version a555c7c: doctor",
			"in-service probe did not run: Render answered 404 for POST /v1/task-runs",
		]);
	});

	it("fails the empty workspace the audit found: no Workflow and no factory services", async () => {
		const { find } = await check(INTENDED, {
			"GET /v1/workflows": { body: "null" },
			"GET /v1/services?factory-gateway": { body: "[]" },
			"GET /v1/services?factory-intake": { body: "[]" },
		});
		expect(find("fail", "no Workflow named factory-workflows exists")).toBeDefined();
		expect(find("fail", "service factory-gateway does not exist")).toBeDefined();
		expect(find("fail", "service factory-intake does not exist")).toBeDefined();
	});

	it("fails each dependency the deployed probe could not reach and a check it did not report", async () => {
		const probe = {
			revision: INTENDED,
			checks: [
				{ name: "sandbox", ok: false, detail: "sandbox create answered 403" },
				{ name: "ledger", ok: true, detail: "cursor 4" },
				{ name: "github", ok: true, detail: "read noresponsehq/noresponse with installation 1" },
			],
		};
		const { find } = await check(INTENDED, {
			"POST /v1/task-runs": { body: JSON.stringify({ id: "trn-1", status: "succeeded", results: [probe] }) },
		});
		expect(find("fail", "deployed factory cannot reach sandbox: sandbox create answered 403")).toBeDefined();
		expect(find("pass", "deployed factory: ledger: cursor 4")).toBeDefined();
		expect(find("fail", "in-service probe did not report noresponse_api")).toBeDefined();
	});

	it("fails a probe that ran on another revision", async () => {
		const probe = { revision: DEPLOYED, checks: [] };
		const { find } = await check(INTENDED, {
			"POST /v1/task-runs": { body: JSON.stringify({ id: "trn-2", status: "succeeded", results: [probe] }) },
		});
		expect(find("fail", "in-service probe ran on a555c7c, not 0123456")).toBeDefined();
	});

	it("refuses a revision that is not a full SHA", async () => {
		const { find } = await check("a555c7c");
		expect(find("fail", "is not a full commit SHA")).toBeDefined();
	});
});
