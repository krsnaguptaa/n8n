import { Logger } from '@n8n/backend-common';
import { GlobalConfig } from '@n8n/config';
import type { SystemTask, SystemTaskClass } from '@n8n/decorators';
import {
	OnLeaderStepdown,
	OnLeaderTakeover,
	OnShutdown,
	SystemTaskMetadata,
} from '@n8n/decorators';
import { Container, Service } from '@n8n/di';
import { ErrorReporter, InstanceSettings } from 'n8n-core';
import { UnexpectedError } from 'n8n-workflow';
import { strict } from 'node:assert';

import { DurableScheduler } from '../durable-scheduler';
import { SystemTaskHandler } from './system-task-handler';
import { resolveSystemTaskSchedule, SystemTaskTimer } from './system-task-timer';
import { systemTaskType } from './system-task-type';

/**
 * The single owner of the system tasks' run loop: it consumes the registry and
 * routes each task to the mode it runs in.
 *
 * - A task marked durable, on a main with the durable scheduler and its
 *   system-task flag on, is handed to the database-backed queue: it gets a
 *   {@link SystemTaskHandler} registered under its task type, so occurrences
 *   claimed for that type are dispatched to it. Nothing provisions those
 *   occurrences yet, so such a task does not run until the job rows exist.
 * - Every other task runs from an in-memory timer on the leader, which is how
 *   all of these tasks ran before the durable scheduler existed.
 *
 * Because the runner owns the loop, it is also the only subscriber to leadership
 * changes and shutdown: a task class carries its schedule and its work, never
 * the wiring that decides when either applies.
 */
@Service()
export class SystemTaskRunner {
	/** Every registered task, by name. */
	private readonly tasks = new Map<string, SystemTask>();

	/** The timers this instance fires the in-memory tasks from, by task name. */
	private readonly timers = new Map<string, SystemTaskTimer>();

	/** In-flight in-memory runs, by task name. */
	private readonly runs = new Map<string, Promise<void>>();

	/** Tasks whose in-flight run has already had an occurrence skipped, by name. */
	private readonly skipWarned = new Set<string>();

	private readonly logger: Logger;

	private initialized = false;

	private timersStarted = false;

	private isShuttingDown = false;

	constructor(
		logger: Logger,
		private readonly metadata: SystemTaskMetadata,
		private readonly durableScheduler: DurableScheduler,
		private readonly globalConfig: GlobalConfig,
		private readonly instanceSettings: InstanceSettings,
		private readonly errorReporter: ErrorReporter,
	) {
		this.logger = logger.scoped('system-tasks');
	}

	/**
	 * Take ownership of the registry: route every task registered so far and
	 * every one registered later, then start the in-memory timers if this
	 * instance is already the leader. Later leadership changes arrive through
	 * {@link startTimers} and {@link stopTimers}.
	 */
	init(): void {
		strict(this.instanceSettings.instanceRole !== 'unset', 'Instance role is not set');

		if (this.initialized) return;
		this.initialized = true;

		this.metadata.subscribe((taskClass) => this.route(taskClass));

		if (this.instanceSettings.isLeader) this.startTimers();
	}

	@OnLeaderTakeover()
	startTimers(): void {
		if (this.isShuttingDown || this.timersStarted) return;

		this.timersStarted = true;
		const from = new Date();
		for (const timer of this.timers.values()) timer.start(from);

		this.logger.debug('Started the in-memory system task timers', { count: this.timers.size });
	}

	/**
	 * Stop firing, then let the runs already started finish: a run holds
	 * transactions on a connection that may be closed right after, so it is
	 * awaited rather than cut off.
	 */
	@OnLeaderStepdown()
	async stopTimers(): Promise<void> {
		this.timersStarted = false;
		for (const timer of this.timers.values()) timer.stop();
		// Logged here rather than after the await: a takeover can land while the runs
		// are still settling, and the log would then describe timers already restarted.
		this.logger.debug('Stopped the in-memory system task timers');

		await Promise.all([...this.runs.values()]);
	}

	@OnShutdown()
	async shutdown(): Promise<void> {
		this.isShuttingDown = true;
		await this.stopTimers();
	}

	/**
	 * Resolve a registered class and give its task a mode. Resolving eagerly is
	 * safe: `@SystemTask()` makes the class injectable before it registers, and
	 * the name and schedule the routing needs live on the instance.
	 *
	 * @throws {UnexpectedError} When a name is registered more than once, whether by
	 * two tasks claiming it or by one task's module being loaded twice. It surfaces
	 * out of {@link init} for a task registered before it, and out of the task's own
	 * `@SystemTask()` decorator for one registered after. Either way the runner is
	 * left half-routed and startup fails, which is the point: a duplicate name is a
	 * coding mistake.
	 */
	private route(taskClass: SystemTaskClass): void {
		const task = Container.get(taskClass);

		if (this.tasks.has(task.name)) {
			throw new UnexpectedError('A system task name is registered more than once', {
				extra: { name: task.name },
			});
		}
		this.tasks.set(task.name, task);

		if (this.runsDurably(task)) {
			this.durableScheduler.registerTaskHandler(
				systemTaskType(task.name),
				new SystemTaskHandler(task, this.logger, (error) =>
					this.reportFailure('A durable system task run failed', task, error),
				),
			);
			// Warn rather than debug while nothing provisions the occurrences: an
			// operator who turns the flag on otherwise sees the task simply stop.
			this.logger.warn(
				'System task handed to the durable scheduler, which does not provision its occurrences yet, so it will not run',
				{ name: task.name },
			);
			return;
		}

		const timer = this.createTimer(task);
		this.timers.set(task.name, timer);
		this.logger.debug('System task will run on an in-memory timer', { name: task.name });

		if (this.timersStarted) timer.start(new Date());
	}

	/**
	 * Whether the task's runs come from the durable scheduler instead of a timer.
	 * Whether that scheduler is active is asked of it rather than re-derived here:
	 * a task routed to a scheduler that drops it would run nowhere at all.
	 */
	private runsDurably(task: SystemTask): boolean {
		return (
			task.durable &&
			this.globalConfig.scheduler.enabledForSystemTasks &&
			this.durableScheduler.isActive()
		);
	}

	private createTimer(task: SystemTask): SystemTaskTimer {
		const schedule = resolveSystemTaskSchedule(task.schedule, this.globalConfig.generic.timezone);

		return new SystemTaskTimer(
			schedule,
			() => {
				void this.run(task);
			},
			(error) =>
				this.reportFailure(
					'Could not plan a system task schedule, so the task will not run',
					task,
					error,
				),
		);
	}

	/**
	 * Run one occurrence in memory, at most one at a time per task: a run that
	 * outlasts its own cadence skips the next occurrence instead of overlapping
	 * itself.
	 */
	private async run(task: SystemTask): Promise<void> {
		if (this.runs.has(task.name)) {
			// Warned once per stuck run, not once per occurrence: a run that never
			// settles would otherwise warn at the task's cadence forever.
			if (!this.skipWarned.has(task.name)) {
				this.skipWarned.add(task.name);
				this.logger.warn('Skipped a system task occurrence, its previous run is still going', {
					name: task.name,
				});
			}
			return;
		}

		const tracked = this.runOnce(task).finally(() => {
			if (this.runs.get(task.name) !== tracked) return;
			this.runs.delete(task.name);
			this.skipWarned.delete(task.name);
		});
		this.runs.set(task.name, tracked);

		await tracked;
	}

	private async runOnce(task: SystemTask): Promise<void> {
		try {
			await task.run();
		} catch (error) {
			// Reported rather than rethrown: a timer callback has no caller to catch it,
			// and one failed occurrence must not end the cadence.
			this.reportFailure('A system task run failed', task, error);
		}
	}

	/**
	 * Report a system task failure to both the log and the error reporter. Both,
	 * because the reporter stops writing to the log once a Sentry DSN is
	 * configured, and an operator would then see nothing.
	 */
	private reportFailure(message: string, task: SystemTask, error: unknown): void {
		this.logger.error(message, { name: task.name, error });
		this.errorReporter.error(error, {
			extra: { systemTask: task.name },
			shouldBeLogged: false,
			// System tasks are background work, so a report must not inherit whatever
			// unrelated HTTP request happens to be active when a run fails.
			shouldIsolate: true,
		});
	}
}
