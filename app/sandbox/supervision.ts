import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import type { SandboxClient } from "./client.js";
import { APP_DIR } from "./types.js";

export async function reviewedSupervisor() {
	const reviewedDigest: string = "";
	const source = await readFile(new URL("../../sandbox/network-supervisor.py", import.meta.url));
	if (!reviewedDigest || createHash("sha256").update(source).digest("hex") !== reviewedDigest)
		throw new Error("Network supervisor independent review is pending");
	return source;
}

export async function initializeSupervision(client: SandboxClient, id: string) {
	const supervisor = await reviewedSupervisor();
	for (const name of ["network-supervisor.py", "supervised-run.mjs", "as-runner.sh"]) {
		await client.upload(
			id,
			`${APP_DIR}/${name}`,
			name === "network-supervisor.py" ? supervisor : await readFile(new URL(`../../sandbox/${name}`, import.meta.url)),
		);
	}
	await client.check(
		id,
		`chown root:root ${APP_DIR}/network-supervisor.py ${APP_DIR}/supervised-run.mjs ${APP_DIR}/as-runner.sh && chmod 444 ${APP_DIR}/network-supervisor.py ${APP_DIR}/supervised-run.mjs ${APP_DIR}/as-runner.sh && python3 -I ${APP_DIR}/network-supervisor.py init --bytes 67108864`,
		{ timeoutMs: 30000 },
	);
}
