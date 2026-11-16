import { z } from "zod";
import type { Ledger } from "./ledger.js";

const eventSchema = z.object({ event_id: z.string(), connector: z.string(), condition_hash: z.string(), rev: z.number().int().nonnegative() });
export async function drainHealth(ledger: Pick<Ledger, "call">, dispatch: (event: z.infer<typeof eventSchema>) => Promise<void>) {
	let after = z.object({ after: z.number().int().nonnegative().safe() }).parse(await ledger.call("cursor")).after;
	for (;;) {
		const health = z
			.object({ events: z.array(eventSchema), next: z.number().int().nonnegative().safe() })
			.parse(await ledger.call(`events?after=${after}`));
		if (health.next < after || health.events.some((event) => event.rev <= after || event.rev > health.next))
			throw new Error("Invalid health cursor page");
		for (const event of health.events) await dispatch(event);
		if (health.next === after) return after;
		await ledger.call("cursor", { after: health.next, expected_after: after });
		after = health.next;
	}
}
