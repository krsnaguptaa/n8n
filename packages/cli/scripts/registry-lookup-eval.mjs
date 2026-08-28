#!/usr/bin/env node
/**
 * Calibration harness for verified-community-node lookup
 * (`src/node-catalog/registry-lookup.ts`).
 *
 * The unit tests pin behaviour on hand-checked cases. This measures it against
 * the whole corpus instead: every built-in node description, and every entry in
 * the production verified-node registry. It is a script rather than a test
 * because it needs the network and takes minutes.
 *
 * Run it whenever the matching rules change, and before moving the feature's
 * rollout flag.
 *
 *   pnpm build   # needs packages/nodes-base and @n8n/ai-utilities dists
 *   node scripts/registry-lookup-eval.mjs
 *   node scripts/registry-lookup-eval.mjs --cache /tmp/catalog.json
 *
 * Metrics, all "higher is better" except the first:
 *
 *   noise         how often lookup speaks up on a query an installed node
 *                 already answers. Probed with every built-in display name and
 *                 with a hand-written list of task phrasings.
 *   recall        how often lookup surfaces a registry node when the query is
 *                 that node's own name, or the service word from its package.
 *
 * The baseline row is what a fuzzy index over the registry would return, which
 * is the approach this replaced.
 *
 * Both probes are proxies. Real agent queries look more like the service-word
 * probe ("firecrawl") than the display-name one ("Firecrawl Scraper Trigger"),
 * so weigh that one highest.
 */

import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const require = createRequire(import.meta.url);
const { NodeSearchEngine } = require('@n8n/ai-utilities/node-catalog');
const {
	findRegistryMatches,
	registryQueryTerms,
} = require('../dist/node-catalog/registry-lookup.js');

const REGISTRY_URL = 'https://api.n8n.io/api/community-nodes';
const PAGE_SIZE = 100;
const SEARCH_LIMIT = 5;

const cliRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const repoRoot = path.resolve(cliRoot, '../..');

const cacheFlag = process.argv.indexOf('--cache');
const cachePath = cacheFlag === -1 ? null : process.argv[cacheFlag + 1];

/** Built-in descriptions, name-prefixed the way postProcessLoaders does. */
function loadBuiltIns() {
	const sources = [
		['packages/nodes-base/dist/types/nodes.json', 'n8n-nodes-base'],
		['packages/@n8n/nodes-langchain/dist/types/nodes.json', '@n8n/n8n-nodes-langchain'],
	];
	return sources.flatMap(([relative, pkg]) => {
		const file = path.join(repoRoot, relative);
		if (!existsSync(file)) throw new Error(`Missing ${relative}. Run pnpm build first.`);
		return JSON.parse(readFileSync(file, 'utf8')).map((d) => ({ ...d, name: `${pkg}.${d.name}` }));
	});
}

async function fetchRegistry() {
	if (cachePath && existsSync(cachePath)) {
		return JSON.parse(readFileSync(cachePath, 'utf8'));
	}

	const byName = new Map();
	for (let page = 1; ; page++) {
		const url = `${REGISTRY_URL}?pagination%5Bpage%5D=${page}&pagination%5BpageSize%5D=${PAGE_SIZE}&maxAiNodeSdk=1`;
		const response = await fetch(url);
		if (!response.ok) throw new Error(`Registry returned ${response.status}`);
		const body = await response.json();
		for (const row of body.data) byName.set(row.attributes.name, row.attributes);
		if (page >= body.meta.pagination.pageCount) break;
	}

	const rows = [...byName.values()];
	if (cachePath) writeFileSync(cachePath, JSON.stringify(rows));
	return rows;
}

/** The service word an agent would actually type, derived from the package. */
function serviceWord(entry) {
	const pkg = entry.name.split('.')[0].replace(/^@[^/]+\//, '');
	const stripped = pkg
		.replace(/^n8n-nodes-/, '')
		.replace(/^nodes-/, '')
		.replace(/-(official|preview|community|trigger)$/, '');
	return stripped.replace(/-/g, ' ').trim();
}

function report(label, cases, gate) {
	let fired = 0;
	let hit = 0;
	const examples = [];
	for (const { query, wanted } of cases) {
		const admitted = gate(query);
		if (admitted.length > 0) fired++;
		if (wanted) {
			if (admitted[0] === wanted) hit++;
			else if (examples.length < 8) examples.push(`  miss "${query}" wanted ${wanted}`);
		} else if (admitted.length > 0 && examples.length < 8) {
			examples.push(`  noise "${query}" -> ${admitted.join(', ')}`);
		}
	}
	const total = cases.length;
	const metric = cases[0]?.wanted
		? `recall ${((hit / total) * 100).toFixed(1)}% (${hit}/${total})`
		: `noise ${((fired / total) * 100).toFixed(1)}% (${fired}/${total})`;
	console.log(`${label.padEnd(46)} ${metric}`);
	examples.forEach((line) => console.log(line));
}

const builtIns = loadBuiltIns();
const registryRows = (await fetchRegistry()).filter((e) =>
	Array.isArray(e.nodeDescription?.properties),
);
const registry = registryRows.map((e) => ({ ...e.nodeDescription, name: e.name }));
// Only vetted entries are offered, matching what the node creator panel shows.
const official = registryRows.filter((e) => e.isOfficialNode);

console.log(
	`built-in nodes: ${builtIns.length}   registry entries: ${registry.length}   official: ${official.length}\n`,
);

const registryEngine = new NodeSearchEngine(registry);

/** What ships: precise, word-anchored matching over vetted entries. */
const lookup = (query) => findRegistryMatches(query, official).map((e) => e.name);

/** Baseline: a fuzzy index over the registry, the approach this replaced. */
const fuzzy = (query) => registryEngine.searchByName(query, SEARCH_LIMIT).map((r) => r.name);

// Task phrasings that an installed node answers. Kept by hand because there is
// no way to generate "what a user would type" from the node set.
const TASK_PHRASES = [
	'send an email',
	'send a slack message',
	'make an http request',
	'set a field',
	'branch on a condition',
	'run on a schedule',
	'query a postgres database',
	'call openai',
	'read a google sheet',
	'merge two branches',
	'wait for a webhook',
	'loop over items',
	'write some javascript',
	'split out items',
	'upload a file to s3',
	'summarise text with an llm',
	'store embeddings in a vector database',
	'transcribe audio',
	'convert to a file',
	'remove duplicates',
];

const probes = [
	['noise: built-in display names', builtIns.map((n) => ({ query: n.displayName }))],
	['noise: task phrasings', TASK_PHRASES.map((query) => ({ query }))],
	[
		'recall: registry service word',
		official
			.map((e) => ({ query: serviceWord(e), wanted: e.name }))
			.filter(({ query }) => registryQueryTerms(query).length > 0),
	],
	[
		'recall: registry display names',
		official.filter((e) => e.displayName).map((e) => ({ query: e.displayName, wanted: e.name })),
	],
];

console.log('=== baseline: fuzzy index over the registry ===');
for (const [label, cases] of probes) report(label, cases, fuzzy);

console.log('\n=== shipped: precise registry lookup ===');
for (const [label, cases] of probes) report(label, cases, lookup);

console.log('\n=== queries from the original request ===');
for (const query of ['firecrawl', 'brave', 'tavily', 'apify']) {
	console.log(`  "${query}" -> ${lookup(query).join(', ') || '(nothing)'}`);
}
