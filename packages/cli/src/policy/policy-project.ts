import type { Logger } from '@n8n/backend-common';
import { ensureError } from '@n8n/utils/errors/ensure-error';

import type { OwnershipService } from '@/services/ownership.service';

/**
 * The project a workflow belongs to for a policy context, or `null` if it can't
 * be resolved.
 *
 * Broken ownership data must not stop a publish, and `projectId` is nullable so a
 * check can decide how careful to be. Warned rather than silent: without a
 * project, instance rules still apply but project rules cannot.
 */
export async function resolvePolicyProjectId(
	ownershipService: OwnershipService,
	logger: Logger,
	workflowId: string,
): Promise<string | null> {
	try {
		const project = await ownershipService.getWorkflowProjectCached(workflowId);

		return project.id;
	} catch (e) {
		logger.warn('Could not resolve the owning project for a policy check', {
			workflowId,
			error: ensureError(e),
		});

		return null;
	}
}
