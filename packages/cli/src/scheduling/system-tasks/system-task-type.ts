/**
 * The task type of a system task's durable job, following the
 * `<domain>:<what>` shape of the other task types (e.g.
 * `workflow:schedule-trigger`).
 *
 * One type per task, rather than a single `system` type for all of them: the
 * executor only claims occurrences whose type has a handler registered, so a
 * main that doesn't know a task (an older binary, a disabled module) leaves its
 * occurrences for a main that does, instead of claiming and failing them.
 */
export function systemTaskType(taskName: string): string {
	return `system:${taskName}`;
}
