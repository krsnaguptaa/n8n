import type { Logger } from '@n8n/backend-common';
import type { SystemTask } from '@n8n/decorators';
import type { ClaimedTask, DispatchDecision, DispatchReporter, TaskHandler } from '@n8n/scheduler';

/**
 * Runs one durable occurrence of a system task.
 *
 * Errors propagate: the executor is what retries the occurrence or gives up on
 * it, following the attempt limit carried by the occurrence's job row.
 */
export class SystemTaskHandler implements TaskHandler {
	constructor(
		private readonly systemTask: SystemTask,
		private readonly logger: Logger,
		/** Called when a run fails, before the error reaches the executor. */
		private readonly onRunError: (error: unknown) => void,
	) {}

	async execute(task: ClaimedTask, report: DispatchReporter): Promise<DispatchDecision> {
		// Non-idempotent work stamps the dispatch marker before it starts, so an
		// occurrence whose run may already have happened is never redelivered. This
		// relies on such work being kept to a single attempt, since rescheduling an
		// attempt clears the marker. Idempotent work stays retryable until it returns.
		const decision =
			this.systemTask.effects === 'non-idempotent' ? report.dispatched() : report.notDispatched();

		try {
			await this.systemTask.run();
		} catch (error) {
			// The executor records a failure on the occurrence's row but reports it
			// nowhere, and an occurrence already marked dispatched is completed as a
			// success on its last attempt. Without this a failed run is invisible,
			// where the same run on an in-memory timer is reported.
			this.onRunError(error);
			throw error;
		}

		this.logger.debug('Ran a system task occurrence', {
			name: this.systemTask.name,
			taskId: task.id,
			jobId: task.jobId,
		});

		return decision;
	}
}
