import { SystemTask } from '@n8n/decorators';
import type { SystemTaskEffects, SystemTaskSchedule } from '@n8n/decorators';

/**
 * A do-nothing system task, so the runner can be exercised against a real
 * registered class while no production task has moved to the registry yet.
 *
 * Every field is writable: a test picks the cadence and the mode it needs
 * before handing the class to the runner.
 *
 * Importing this module registers it in the global `SystemTaskMetadata`, so a
 * test that goes through the global registry rather than its own instance sees
 * it alongside the production tasks.
 */
@SystemTask()
export class DummySystemTask implements SystemTask {
	name = 'dummy';

	schedule: SystemTaskSchedule = { kind: 'interval', intervalSeconds: 60 };

	effects: SystemTaskEffects = 'idempotent';

	durable = false;

	runCount = 0;

	/** How a run settles. Replace it to make a run fail or to hold it open. */
	onRun: () => Promise<void> = async () => {};

	async run(): Promise<void> {
		this.runCount++;
		await this.onRun();
	}
}

/** A second dummy, for tests that need two tasks at once. */
@SystemTask()
export class OtherDummySystemTask extends DummySystemTask {
	name = 'other-dummy';
}
