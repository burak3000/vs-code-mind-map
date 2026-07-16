#!/usr/bin/env node
// Generates benchmark fixture .md files (addendum §7.1: "100 / 500 / 2,000 /
// 5,000 nodes with realistic text lengths and link density").
//
// Structure follows the plan's md<->mindmap mapping (plan §7.1): H1 root,
// H2 first-level branches, nested list items below. Tree shape is a
// deterministic (seeded) random recursive tree, which gives a realistic mix
// of breadth and depth without special-casing.

import { writeFileSync, mkdirSync } from "fs";
import { fileURLToPath } from "url";
import { dirname, join } from "path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const FIXTURES_DIR = join(__dirname, "..", "fixtures");
// NOTE (port deviation from the reference repo): the Obsidian version also
// copied fixtures into `dev-vault/fixtures/` so they were directly openable
// in a real vault. This extension has no vault/workspace-folder equivalent
// bundled with the repo, so that second copy is dropped — manual perf/
// interaction checks (CLAUDE.md) should open `fixtures/*.md` directly in the
// Extension Development Host against any workspace folder instead.

const SIZES = [100, 500, 2000, 5000];
const LINK_DENSITY = 1 / 15; // ~1 in 15 nodes carries a link
const WORDS = (
	"strategy roadmap research design review budget timeline risk " +
	"customer feedback launch metrics growth architecture backend frontend " +
	"api schema migration onboarding retention pricing experiment " +
	"analytics dashboard incident postmortem hiring interview offsite " +
	"security compliance accessibility performance latency caching " +
	"scaling infra deploy rollback release notes draft proposal outline"
).split(" ");

// mulberry32 seeded PRNG for reproducible fixtures.
function mulberry32(seed) {
	let a = seed;
	return function () {
		a |= 0;
		a = (a + 0x6d2b79f5) | 0;
		let t = Math.imul(a ^ (a >>> 15), 1 | a);
		t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
	};
}

function makeText(rng, min = 2, max = 7) {
	const len = min + Math.floor(rng() * (max - min + 1));
	const words = [];
	for (let i = 0; i < len; i++) {
		words.push(WORDS[Math.floor(rng() * WORDS.length)]);
	}
	words[0] = words[0][0].toUpperCase() + words[0].slice(1);
	return words.join(" ");
}

function maybeLink(rng, text) {
	if (rng() >= LINK_DENSITY) return text;
	const kind = Math.floor(rng() * 3);
	if (kind === 0) return `${text} [[Note ${Math.floor(rng() * 1000)}]]`;
	if (kind === 1) return `${text} [ref](https://example.com/${Math.floor(rng() * 10000)})`;
	return `${text} [[Attachments/file-${Math.floor(rng() * 1000)}.pdf]]`;
}

function buildTree(targetCount, rng) {
	const root = { text: "Central Topic", children: [], depth: 0 };
	const numMainBranches = Math.min(10, Math.max(4, Math.round(Math.sqrt(targetCount) / 2)));

	const allNodes = [root];
	for (let i = 0; i < numMainBranches && allNodes.length < targetCount; i++) {
		const branch = { text: makeText(rng, 2, 4), children: [], depth: 1, parent: root };
		root.children.push(branch);
		allNodes.push(branch);
	}

	while (allNodes.length < targetCount) {
		// Uniform pick over all existing non-root nodes -> random recursive
		// tree shape: a realistic mix of breadth and depth.
		const candidates = allNodes.length - 1;
		const idx = 1 + Math.floor(rng() * candidates);
		const parent = allNodes[idx];
		const child = {
			text: maybeLink(rng, makeText(rng)),
			children: [],
			depth: parent.depth + 1,
			parent,
		};
		parent.children.push(child);
		allNodes.push(child);
	}

	return root;
}

function serialize(root) {
	const lines = [`# ${root.text}`];
	for (const branch of root.children) {
		lines.push(`## ${branch.text}`);
		// DFS preserving document order (children in creation order).
		const dfs = (node, relDepth) => {
			lines.push(`${"  ".repeat(relDepth)}- ${node.text}`);
			for (const child of node.children) dfs(child, relDepth + 1);
		};
		for (const child of branch.children) dfs(child, 0);
	}
	return lines.join("\n") + "\n";
}

mkdirSync(FIXTURES_DIR, { recursive: true });

for (const size of SIZES) {
	const rng = mulberry32(0xc0ffee ^ size);
	const tree = buildTree(size, rng);
	const md = serialize(tree);
	const fileName = `${size}-nodes.md`;
	writeFileSync(join(FIXTURES_DIR, fileName), md, "utf8");
	console.log(`wrote ${fileName} (${md.split("\n").length - 1} lines)`);
}
