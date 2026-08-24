import { computed } from 'vue';
import { useRouter } from 'vue-router';
import { CANVAS_NODE_CONTEXT_FLAG } from '@n8n/api-types';
import { TELEMETRY_EVENT } from '@n8n/telemetry';
import { usePostHog } from '@/app/stores/posthog.store';
import { useToast } from '@n8n/composables/useToast';
import { useTelemetry } from '@n8n/composables/useTelemetry';
import { useI18n } from '@n8n/i18n';
import { useInstanceAiStore } from '../instanceAi.store';
import { useInstanceAiHandoff, stashPendingDraftAttachment } from './useInstanceAiHandoff';
import { INSTANCE_AI_THREAD_VIEW } from '../constants';
import { buildNodesAttachment, type NodeContextWorkflow } from '../utils/buildNodesAttachment';
import { useEditorContext } from '@/app/composables/useEditorContext';
import type { IWorkflowDb } from '@/Interface';

/** Which affordance triggered add-to-chat — mirrors the telemetry event's `source`. */
export type AddNodesToChatSource =
	| 'node_toolbar'
	| 'selection_toolbar'
	| 'context_menu'
	| 'group_title_bar'
	| 'keyboard';

export function useAddNodesToChat() {
	const posthog = usePostHog();
	const store = useInstanceAiStore();
	const handoff = useInstanceAiHandoff();
	const router = useRouter();
	const toast = useToast();
	const telemetry = useTelemetry();
	const i18n = useI18n();
	const { instanceAi } = useEditorContext();

	// The add-to-chat affordance only works when Instance AI is actually
	// available — gating on the flag alone would surface an unusable control and
	// suppress the legacy Focus AI action.
	const isNodeContextEnabled = computed(
		() => posthog.isFeatureEnabled(CANVAS_NODE_CONTEXT_FLAG) && instanceAi.value,
	);

	async function addSelectedNodesToChat(params: {
		workflowId: string;
		selectedNodeIds: string[];
		workflow: NodeContextWorkflow;
		isInsideThread: boolean;
		onStaged?: () => void;
		workflowName?: string;
		workflowSnapshot?: IWorkflowDb;
		source?: AddNodesToChatSource;
	}): Promise<void> {
		const built = buildNodesAttachment(params.workflowId, params.selectedNodeIds, params.workflow);
		if (!built) return;

		if (params.source) {
			telemetry.track(TELEMETRY_EVENT.INSTANCE_AI.USER_ADDED_NODES_TO_CHAT, {
				source: params.source,
				node_count: built.attachment.sets.reduce((sum, set) => sum + set.nodes.length, 0),
			});
		}
		if (built.truncated) {
			toast.showMessage({
				type: 'warning',
				title: i18n.baseText('instanceAi.nodeContext.truncated.title'),
				message: i18n.baseText('instanceAi.nodeContext.truncated.message'),
			});
		}

		if (params.isInsideThread) {
			store.stageNodeSets(params.workflowId, built.attachment.sets);
			params.onStaged?.();
			return;
		}

		const threadId = await handoff.openThreadForDraft({
			id: params.workflowId,
			name: params.workflowName,
			snapshot: params.workflowSnapshot,
		});
		if (!threadId) return;
		stashPendingDraftAttachment(threadId, built.attachment.sets, params.workflowId);
		await router.push({ name: INSTANCE_AI_THREAD_VIEW, params: { threadId } });
	}

	return { isNodeContextEnabled, addSelectedNodesToChat };
}
