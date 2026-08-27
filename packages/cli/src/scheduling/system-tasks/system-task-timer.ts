import type { SystemTaskSchedule } from '@n8n/decorators';
import type { Schedule } from '@n8n/scheduler';
import { computeFirstRunAt, computeNextRunAt } from '@n8n/scheduler';
import { ensureError } from '@n8n/utils/errors/ensure-error';
import type { CronExpression } from 'n8n-workflow';

/**
 * Node fires a timeout longer than this straight away (the delay is a signed
 * 32-bit millisecond value), so a longer wait is split into hops.
 */
const MAX_TIMEOUT_MS = 2 ** 31 - 1;

/**
 * One task's in-memory cadence: a chained timeout firing `onFire` at every
 * occurrence of `schedule`.
 *
 * Each fire is planned from the previous planned instant, not from the moment
 * the timer fired, so a slow callback doesn't drift the cadence. The next fire
 * is armed before the callback runs, so a throw inside it cannot end the chain.
 *
 * Occurrences the process slept through are coalesced: the timer fires once and
 * resumes from now, rather than replaying the whole backlog.
 */
export class SystemTaskTimer {
	private timer: NodeJS.Timeout | undefined;

	constructor(
		private readonly schedule: Schedule,
		private readonly onFire: () => void,
		/** Called when the schedule can't be planned; the timer then stays stopped. */
		private readonly onPlanError: (error: Error) => void,
		/** The clock delays are measured against, injectable so a test can stall it. */
		private readonly now: () => number = Date.now,
	) {}

	/** Arm the first fire, counted from `from`. Replaces a running timer. */
	start(from: Date): void {
		this.stop();
		this.arm(from, true);
	}

	stop(): void {
		clearTimeout(this.timer);
		this.timer = undefined;
	}

	/**
	 * Arm the next fire. `isFirst` seeds a fresh cadence from an arbitrary instant;
	 * otherwise `after` must be a real fire, since a `recurring_cron` counts its
	 * periods from the one before.
	 */
	private arm(after: Date, isFirst: boolean): void {
		let next: Date | null;
		try {
			next = isFirst
				? computeFirstRunAt(this.schedule, after)
				: computeNextRunAt(this.schedule, after);
		} catch (error) {
			this.timer = undefined;
			this.onPlanError(ensureError(error));
			return;
		}

		// Only a one-off schedule is ever exhausted, and a system task's schedule excludes it.
		if (next === null) {
			this.timer = undefined;
			return;
		}

		const delayMs = next.getTime() - this.now();

		// A whole occurrence already went by, so the process was stalled or suspended
		// across it. The fire it belongs to still runs (the callback that got here is
		// late, not skipped), but the cadence reseeds from now instead of replaying
		// every occurrence in between.
		if (delayMs < 0) {
			this.arm(new Date(this.now()), true);
			return;
		}

		this.waitFor(next, delayMs);
	}

	/**
	 * Wait `delayMs` for the occurrence at `fireAt`, then fire it and arm the next
	 * one. A wait beyond the horizon is split into hops that keep waiting for the
	 * same instant, so an occurrence the process slept through mid-hop still fires
	 * late rather than being dropped.
	 */
	private waitFor(fireAt: Date, delayMs: number): void {
		if (delayMs > MAX_TIMEOUT_MS) {
			this.timer = setTimeout(
				() => this.waitFor(fireAt, fireAt.getTime() - this.now()),
				MAX_TIMEOUT_MS,
			);
			return;
		}

		this.timer = setTimeout(
			() => {
				this.arm(fireAt, false);
				this.onFire();
			},
			Math.max(0, delayMs),
		);
	}
}

/**
 * A task's schedule in the shape the recurrence math takes, with a cron
 * expression's `null` timezone resolved to the instance default.
 */
export function resolveSystemTaskSchedule(
	schedule: SystemTaskSchedule,
	defaultTimezone: string,
): Schedule {
	switch (schedule.kind) {
		case 'interval':
			return schedule;
		case 'cron':
		case 'recurring_cron':
			return {
				...schedule,
				// A definition carries the expression as a plain string; the recurrence
				// math validates it on the first plan, so a malformed one surfaces as a
				// plan error instead of a wrong instant.
				cronExpression: schedule.cronExpression as CronExpression,
				timezone: schedule.timezone ?? defaultTimezone,
			};
	}
}
