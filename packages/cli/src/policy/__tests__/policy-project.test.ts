import type { Logger } from '@n8n/backend-common';
import type { Project } from '@n8n/db';
import { mock } from 'vitest-mock-extended';

import type { OwnershipService } from '@/services/ownership.service';

import { resolvePolicyProjectId } from '../policy-project';

describe('resolvePolicyProjectId', () => {
	const logger = mock<Logger>();
	const ownershipService = mock<OwnershipService>();

	beforeEach(() => {
		vi.clearAllMocks();
	});

	it('returns the id of the owning project', async () => {
		ownershipService.getWorkflowProjectCached.mockResolvedValue(mock<Project>({ id: 'project-1' }));

		await expect(resolvePolicyProjectId(ownershipService, logger, 'wf-1')).resolves.toBe(
			'project-1',
		);
		expect(logger.warn).not.toHaveBeenCalled();
	});

	// Broken data (a workflow with no owner row) must not stop the workflow from
	// being published; the check is told there is no project scope instead.
	it('returns null and warns when ownership cannot be resolved', async () => {
		ownershipService.getWorkflowProjectCached.mockRejectedValue(new Error('no owner row'));

		await expect(resolvePolicyProjectId(ownershipService, logger, 'wf-1')).resolves.toBeNull();
		expect(logger.warn).toHaveBeenCalledWith(
			'Could not resolve the owning project for a policy check',
			expect.objectContaining({ workflowId: 'wf-1' }),
		);
	});
});
