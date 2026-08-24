import { mockInstance } from '@n8n/backend-test-utils';
import type { Project } from '@n8n/db';
import { mock } from 'vitest-mock-extended';

import { OwnershipService } from '@/services/ownership.service';

/**
 * Mocks {@link OwnershipService} so every workflow resolves to one project.
 *
 * Publishing resolves the owning project to police the publish, so a bare
 * `mockInstance(OwnershipService)` leaves suites exercising activation on the
 * null-project fallback rather than the normal path.
 */
export const mockWorkflowOwnership = (projectId = 'project-id') =>
	mockInstance(OwnershipService, {
		getWorkflowProjectCached: vi.fn().mockResolvedValue(mock<Project>({ id: projectId })),
	});
