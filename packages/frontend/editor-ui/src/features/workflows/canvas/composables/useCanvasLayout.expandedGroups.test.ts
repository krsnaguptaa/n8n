/**
 * Repro for ADO-5842: tidy-up lays out expanded-group members with no cluster
 * constraint, so members of different groups interleave and the group frames
 * (recomputed from member positions) overlap in the layout output.
 *
 * The live group-push layer usually repairs this visually, but not when a
 * group is excluded from push sources — the default state for groups created
 * in the current session (and for expanded groups the user has moved). In
 * that state the raw layout output below is exactly what gets rendered.
 *
 * Workflow fixture is taken verbatim from the ticket.
 */
import { useVueFlow, type VueFlowStore } from '@vue-flow/core';
import { computed, ref, shallowRef } from 'vue';

import {
	checkOverlap,
	createEmptyCanvasRenderData,
	type CanvasRenderData,
} from '@/features/workflows/canvas/canvas.utils';
import {
	createCanvasGraphEdge,
	createCanvasGraphGroupNode,
	createCanvasGraphNode,
} from '@/features/workflows/canvas/__tests__/utils';
import type { INodeUi } from '@/Interface';
import { createCanvasGroupNodeId } from '../canvas.types';
import { useCanvasLayout } from './useCanvasLayout';
import { computeGroupFrameRects, computeNodesRectFromStore } from './useCanvasMapping.groups';
import {
	computeNodeGroupLayoutPushes,
	type NodeGroupLayoutComponent,
} from './useCanvasNodeGroupLayout';

vi.mock('@vue-flow/core');

// Node name → position, from the ticket's workflow JSON
const NODE_POSITIONS: Record<string, [number, number]> = {
	'When Executed by Another Workflow': [-64, 64],
	'Route Branch': [160, 48],
	'A Validate': [384, -256],
	'A Enrich': [608, -256],
	'A Format': [832, -128],
	'A Send': [1216, -128],
	'Collect Branches': [1584, 112],
	'B Transform': [832, 64],
	'B Store': [1216, 64],
	'C Inspect': [368, 544],
	'C Score': [592, 544],
	'Needs Escalation?': [832, 304],
	'Escalation Notify': [1104, 512],
	'Escalation Log': [1328, 512],
	'Wrap Summarize': [1856, 272],
	'Wrap Archive': [2080, 272],
};

const CONNECTIONS: Array<[string, string]> = [
	['When Executed by Another Workflow', 'Route Branch'],
	['Route Branch', 'A Validate'],
	['Route Branch', 'B Transform'],
	['Route Branch', 'C Inspect'],
	['A Validate', 'A Enrich'],
	['A Enrich', 'A Format'],
	['A Format', 'A Send'],
	['A Send', 'Collect Branches'],
	['B Transform', 'B Store'],
	['B Store', 'Collect Branches'],
	['C Inspect', 'C Score'],
	['C Score', 'Needs Escalation?'],
	['Needs Escalation?', 'Escalation Notify'],
	['Needs Escalation?', 'Collect Branches'],
	['Escalation Notify', 'Escalation Log'],
	['Escalation Log', 'Collect Branches'],
	['Collect Branches', 'Wrap Summarize'],
	['Wrap Summarize', 'Wrap Archive'],
];

const GROUPS = [
	{ id: 'a-prepare', name: '2. Branch A - Prepare', nodeIds: ['A Validate', 'A Enrich'] },
	{ id: 'a-deliver', name: '3. Branch A - Deliver', nodeIds: ['A Format', 'A Send'] },
	{ id: 'b-process', name: '4. Branch B - Process', nodeIds: ['B Transform', 'B Store'] },
	{ id: 'c-review', name: '5. Branch C - Review', nodeIds: ['C Inspect', 'C Score'] },
	{ id: 'escalation', name: '6. Escalation', nodeIds: ['Escalation Notify', 'Escalation Log'] },
	{ id: 'wrap-up', name: '7. Wrap-up', nodeIds: ['Wrap Summarize', 'Wrap Archive'] },
];

function toStoreNode(id: string, position: [number, number]): INodeUi {
	return {
		id,
		name: id,
		position,
		type: 'n8n-nodes-base.noOp',
		typeVersion: 1,
		parameters: {},
	} as INodeUi;
}

/** Expanded group frames derived from node positions, as the canvas draws them. */
function computeGroupFrames(positions: Map<string, { x: number; y: number }>) {
	const getNodeById = (id: string) => {
		const position = positions.get(id);
		return position ? toStoreNode(id, [position.x, position.y]) : undefined;
	};

	return GROUPS.map((group) => ({
		name: group.name,
		frame: computeGroupFrameRects(computeNodesRectFromStore(group.nodeIds, getNodeById)).expanded,
	}));
}

function findOverlappingGroupPairs(positions: Map<string, { x: number; y: number }>): string[] {
	const frames = computeGroupFrames(positions);
	const pairs: string[] = [];
	for (let i = 0; i < frames.length; i++) {
		for (let j = i + 1; j < frames.length; j++) {
			if (checkOverlap(frames[i].frame, frames[j].frame)) {
				pairs.push(`"${frames[i].name}" overlaps "${frames[j].name}"`);
			}
		}
	}
	return pairs;
}

function computeGroupLayoutComponents(
	positions: Map<string, { x: number; y: number }>,
): NodeGroupLayoutComponent[] {
	const getNodeById = (id: string) => {
		const position = positions.get(id);
		return position ? toStoreNode(id, [position.x, position.y]) : undefined;
	};

	return GROUPS.map((group) => {
		const { collapsed, expanded } = computeGroupFrameRects(
			computeNodesRectFromStore(group.nodeIds, getNodeById),
		);

		return {
			id: createCanvasGroupNodeId(group.id),
			kind: 'group',
			groupId: group.id,
			nodeIds: [...group.nodeIds],
			rect: expanded,
			collapsedRect: collapsed,
			expandedRect: expanded,
		};
	});
}

function setupLayout() {
	const graphNodes = Object.entries(NODE_POSITIONS).map(([id, [x, y]]) =>
		createCanvasGraphNode({ id, position: { x, y } }),
	);
	const graphNodesById = new Map(graphNodes.map((node) => [node.id, node]));

	// Keep the expanded group nodes in the store for fidelity with the real canvas.
	const initialPositions = new Map(
		Object.entries(NODE_POSITIONS).map(([id, [x, y]]) => [id, { x, y }]),
	);
	const groupChips = GROUPS.map((group) => {
		const frame = computeGroupFrames(initialPositions).find(
			({ name }) => name === group.name,
		)!.frame;
		return createCanvasGraphGroupNode({
			id: group.id,
			nodeIds: [...group.nodeIds],
			isCollapsed: false,
			position: { x: frame.x, y: frame.y },
			nodesRect: frame,
		});
	});

	const edges = CONNECTIONS.map(([sourceId, targetId]) =>
		createCanvasGraphEdge(graphNodesById.get(sourceId)!, graphNodesById.get(targetId)!),
	);
	const edgesById = new Map(edges.map((edge) => [edge.id, edge]));

	const allNodes = [...graphNodes, ...groupChips];
	const allNodesById = new Map(allNodes.map((node) => [node.id, node]));

	vi.mocked(useVueFlow).mockReturnValue({
		nodes: ref(allNodes),
		edges: ref(edges),
		getSelectedNodes: ref([]),
		findNode: (nodeId: string) => allNodesById.get(nodeId),
		findEdge: (edgeId: string) => edgesById.get(edgeId),
	} as unknown as VueFlowStore);

	return useCanvasLayout(
		'test-canvas-id',
		computed(() => false),
		shallowRef<CanvasRenderData>(createEmptyCanvasRenderData()),
	);
}

describe('useCanvasLayout with expanded node groups', () => {
	test('does not produce overlapping group frames (ADO-5842)', () => {
		const { layout } = setupLayout();

		const result = layout('all');
		const positions = new Map(result.nodes.map((node) => [node.id, { x: node.x, y: node.y }]));

		expect(findOverlappingGroupPairs(positions)).toEqual([]);
		expect(
			computeNodeGroupLayoutPushes({
				components: computeGroupLayoutComponents(positions),
				expandedGroupIds: new Set(GROUPS.map((group) => group.id)),
				expandedGroupIdOrder: GROUPS.map((group) => group.id),
			}),
		).toEqual([]);
	});
});
