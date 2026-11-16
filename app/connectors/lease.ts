import type { Sandbox } from "../sandbox/index.js";
import type { Claimed, Ledger, State } from "./ledger.js";

export class Lease {
	private queue: Promise<unknown> = Promise.resolve();
	private failed = false;
	private timer: ReturnType<typeof setInterval> | undefined;
	private readonly sandboxes = new Set<Sandbox>();
	constructor(
		readonly ledger: Ledger,
		readonly claim: Claimed,
		readonly seconds: number,
	) {}
	async exclusive<T>(action: () => Promise<T>): Promise<T> {
		const next = this.queue.then(async () => {
			if (this.failed) throw new Error("Factory lease lost");
			return action();
		});
		this.queue = next.catch(() => {});
		return next;
	}
	async checkpoint(patch: Partial<Omit<State, "version">> = {}) {
		return this.exclusive(() => this.ledger.heartbeat(this.claim, this.seconds, patch));
	}
	track<T extends Sandbox>(sandbox: T): T {
		this.sandboxes.add(sandbox);
		return sandbox;
	}
	start() {
		this.timer = setInterval(
			() => {
				void this.checkpoint().catch(async () => {
					this.failed = true;
					await Promise.allSettled([...this.sandboxes].map((s) => s.close()));
				});
			},
			Math.max(1000, Math.min(30000, (this.seconds * 1000) / 3)),
		);
	}
	async stop() {
		if (this.timer) clearInterval(this.timer);
		await this.queue;
	}
}
