import type { Sandbox } from "../sandbox/index.js";
import type { Claimed, Ledger, State } from "./ledger.js";

export class Lease {
	private queue: Promise<unknown> = Promise.resolve();
	private failed = false;
	private readonly abort = new AbortController();
	private deadlineTimer: ReturnType<typeof setTimeout> | undefined;
	readonly deadline = Date.now() + 14400000;
	get signal() {
		return this.abort.signal;
	}
	private async lose() {
		this.failed = true;
		this.abort.abort();
		await Promise.allSettled([...this.sandboxes].map((s) => s.close()));
	}
	private timer: ReturnType<typeof setInterval> | undefined;
	private readonly sandboxes = new Set<Sandbox>();
	constructor(
		readonly ledger: Ledger,
		readonly claim: Claimed,
		readonly seconds: number,
	) {}
	async exclusive<T>(action: () => Promise<T>): Promise<T> {
		const next = this.queue.then(async () => {
			if (this.failed || Date.now() >= this.deadline) throw new Error("Factory lease lost");
			return action();
		});
		this.queue = next.catch(() => {});
		return next;
	}
	async checkpoint(patch: Partial<Omit<State, "version">> = {}) {
		return this.exclusive(() => this.ledger.heartbeat(this.claim, this.seconds, patch));
	}
	track<T extends Sandbox>(sandbox: T): T {
		const execute = sandbox.exec.bind(sandbox);
		sandbox.exec = (command, opts = {}) => {
			if (this.failed || Date.now() >= this.deadline) throw new Error("Factory absolute deadline or lease lost");
			return execute(command, { ...opts, signal: this.signal, timeoutMs: Math.min(opts.timeoutMs ?? 3600000, this.deadline - Date.now()) });
		};
		this.sandboxes.add(sandbox);
		return sandbox;
	}
	start() {
		this.deadlineTimer = setTimeout(
			() => {
				void this.lose();
			},
			Math.max(1, this.deadline - Date.now()),
		);
		this.timer = setInterval(
			() => {
				void this.checkpoint().catch(() => this.lose());
			},
			Math.max(1000, Math.min(30000, (this.seconds * 1000) / 3)),
		);
	}
	async stop() {
		if (this.timer) clearInterval(this.timer);
		if (this.deadlineTimer) clearTimeout(this.deadlineTimer);
		await this.queue;
	}
}
