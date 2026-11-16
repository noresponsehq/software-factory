import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { affectedConnectors, trustedBuild } from "../app/connectors/trusted-build.js";
import { assertProbe, type Control } from "../app/connectors/probe-assertions.js";
import type { GitHubHttp } from "../app/github/index.js";
import type { OpenedSandbox } from "../app/sandbox/index.js";
import type { TrustedControl } from "../app/connectors/trusted-controls.js";

const head = "a".repeat(40);
const declared: Control = {
	known: { By: "email", Present: "", Absent: "", Fields: ["id"], Supplied: true, PresentOnly: false, Paid: true },
	trials: 5,
	admitted_ms: 5000,
};
const trusted: TrustedControl = {
	connector: "gravatar",
	variant: "present",
	by: "email",
	found: true,
	value: "synthetic@example.invalid",
	region: null,
	subject: { field: "id", value: "synthetic-id" },
	expected: {},
	provenance: { kind: "supplied_control", source: "offline-fixture" },
	verified_at: "2026-11-17T00:00:00Z",
	fresh_until: "2099-01-01T00:00:00Z",
	stale: false,
	written_by: "operator",
	written_role: "operator",
	rev: 1,
};
function boundary(paths: string[]) {
	const files = ["apps/identity/internal/connectors/gravatar/gravatar.go", "apps/identity/internal/cookies/parse.go"].map((path) => {
		const data = Buffer.from("package fixture\n");
		const sha = createHash("sha1").update(`blob ${data.length}\0`).update(data).digest("hex");
		return { path, data, sha, type: "blob", mode: "100644" };
	});
	const http = {
		json: vi.fn(async (_method: string, route: string) => {
			if (route.includes("/compare/")) return { files: paths.map((filename) => ({ filename })) };
			if (route.includes("/git/trees/")) return { truncated: false, tree: files };
			if (route.includes("/git/blobs/")) return { encoding: "base64", content: files[0].data.toString("base64"), size: files[0].data.length };
			throw new Error(route);
		}),
	} as unknown as GitHubHttp;
	const sandbox = {
		id: "offline",
		headSha: "b".repeat(40),
		upload: vi.fn(async () => {}),
		close: vi.fn(),
		download: vi.fn(async (path: string) => Buffer.from(path.endsWith("main.go") ? "package main\nfunc main() {}" : "package connectors\n")),
		exec: vi.fn(async (command: string) => ({
			exitCode: 0,
			stderr: "",
			stdout: command.includes("control-pin.go")
				? "unchanged-pin"
				: command.includes("/tmp/factory-control policy")
					? JSON.stringify({ trials: 5, admitted_ms: 5000 })
					: command.startsWith("/tmp/factory-control control")
						? JSON.stringify(declared)
						: command === "/tmp/factory-control connectors"
							? JSON.stringify(["gravatar"])
							: command.includes("go list")
								? "github.com/noresponsehq/noresponse/apps/identity/internal/connectors/gravatar github.com/noresponsehq/noresponse/apps/identity/internal/cookies\n"
								: "",
		})),
	} as unknown as OpenedSandbox;
	return { http, sandbox };
}

describe("independent trusted build invariants", () => {
	it("counts affected connectors once when the runtime appends its selected connector", () => {
		const ids = Array.from({ length: 25 }, (_, i) => `platform${i}`);
		const shared = "github.com/noresponsehq/noresponse/apps/identity/internal/cookies";
		const listing = ids.map((id) => `github.com/noresponsehq/noresponse/apps/identity/internal/connectors/${id} ${shared}`).join("\n");
		expect(affectedConnectors(listing, [...ids, ids[0]], ["apps/identity/internal/cookies"], ids[0])).toEqual([...ids].sort());
	});
	it("keeps the trusted main paid-lookup refusal when ledger controls replace identifiers", async () => {
		const { http, sandbox } = boundary(["apps/identity/internal/connectors/gravatar/gravatar.go"]);
		const source = await trustedBuild(sandbox, http, "o/r", head, "gravatar", async () => [trusted]);
		const lookup = vi.fn(async (_value: string, network: boolean) => ({
			output: network
				? { found: true, fields: ["id"], values: { id: ["synthetic-id"] }, took_ms: 1 }
				: { found: false, fields: [], error: "unavailable", took_ms: 1 },
			elapsedMs: 1,
		}));
		await expect(assertProbe(source.targets[0].control, lookup, source.targets[0].trusted)).rejects.toThrow("Paid lookup allowance is missing");
		expect(lookup).not.toHaveBeenCalled();
	});
	it("allows a shared-adapter-only repair without demanding an unrelated connector edit", async () => {
		const { http, sandbox } = boundary(["apps/identity/internal/cookies/parse.go"]);
		await expect(trustedBuild(sandbox, http, "o/r", head, "gravatar", async () => [trusted])).resolves.toMatchObject({
			scope: { kind: "shared", packages: ["apps/identity/internal/cookies"] },
		});
	});
});
