import { MindMapModel, MindNode } from "../model/types";
import { createId } from "../model/id";
import { applyMindmapDataToTree, extractMindmapData } from "./metadata";

const HEADING_RE = /^(#{1,6})\s+(.*)$/;
const LIST_RE = /^( *)[-*+]\s+(.*)$/;
const BLOCK_ID_RE = /\s\^([A-Za-z0-9_-]+)$/;
const FRONTMATTER_DELIM = "---";

interface StackFrame {
	node: MindNode;
	kind: "root" | "heading" | "list";
	level: number; // heading: 1-6; list: indent level (0-based); root: -1
}

/** Splits a trailing ` ^blockid` (persisted node identity, plan §7.2) off a heading/list line's text, if present. */
function stripBlockId(text: string): { text: string; id: string | null } {
	const match = BLOCK_ID_RE.exec(text);
	if (!match) return { text, id: null };
	return { text: text.slice(0, match.index).trimEnd(), id: match[1] };
}

function createNode(rawText: string, parent: MindNode | null, depth: number): MindNode {
	const { text, id } = stripBlockId(rawText);
	return {
		id: id ?? createId(),
		text,
		children: [],
		parent,
		depth,
		folded: false,
		subtreeCount: 0,
	};
}

/**
 * If the file starts with a `---` YAML frontmatter block, extracts it
 * verbatim (delimiters included) so it can be preserved untouched on
 * serialize (N2) even before this plugin understands/uses any of its keys.
 */
function extractFrontmatter(source: string): { frontmatterRaw: string | null; body: string } {
	if (!source.startsWith(`${FRONTMATTER_DELIM}\n`) && source !== FRONTMATTER_DELIM) {
		return { frontmatterRaw: null, body: source };
	}
	const lines = source.split(/\r?\n/);
	for (let i = 1; i < lines.length; i++) {
		if (lines[i] === FRONTMATTER_DELIM) {
			const frontmatterRaw = lines.slice(0, i + 1).join("\n");
			const body = lines.slice(i + 1).join("\n").replace(/^\n/, "");
			return { frontmatterRaw, body };
		}
	}
	// Unterminated frontmatter block: treat the whole file as body rather
	// than guessing — safer than silently swallowing content.
	return { frontmatterRaw: null, body: source };
}

/**
 * Parses the heading + nested-list subset of markdown into a MindMapModel
 * (plan §7.1). Single O(n) pass over lines using a stack of active
 * ancestors. Non-heading/non-list lines (paragraphs, code fences, blank
 * lines) are captured as `attachedContent` on the preceding node so the
 * serializer can round-trip them (N2/N3).
 */
export function parseMindMap(source: string, fallbackTitle: string): MindMapModel {
	const { frontmatterRaw, body } = extractFrontmatter(source);

	const root = createNode(fallbackTitle, null, 0);
	const stack: StackFrame[] = [{ node: root, kind: "root", level: -1 }];
	let firstHeadingSeen = false;
	let hasExplicitRootHeading = false;
	let pendingContent: string[] = [];

	const flushPendingContent = (target: MindNode) => {
		if (pendingContent.length === 0) return;
		target.attachedContent = (target.attachedContent ?? []).concat(pendingContent);
		pendingContent = [];
	};

	// A well-formed text file ends with exactly one trailing newline; strip
	// it before splitting so it doesn't show up as a spurious blank line
	// (the serializer always re-adds exactly one trailing newline on output).
	const trimmedBody = body.endsWith("\n") ? body.slice(0, -1) : body;
	const lines = trimmedBody.split(/\r?\n/);
	for (const line of lines) {
		const headingMatch = HEADING_RE.exec(line);
		if (headingMatch) {
			const level = headingMatch[1].length;
			const text = headingMatch[2].trim();

			if (!firstHeadingSeen && level === 1) {
				// First H1 in the file becomes the root itself, not a child.
				firstHeadingSeen = true;
				hasExplicitRootHeading = true;
				flushPendingContent(root);
				root.text = stripBlockId(text).text;
				continue;
			}
			firstHeadingSeen = true;
			flushPendingContent(stack[stack.length - 1].node);

			// Pop any active list context and any heading frames at level >= the
			// new heading's level. These interleave (a list sits "inside" its
			// heading), so pop in a single loop rather than two passes.
			while (stack.length > 1) {
				const top = stack[stack.length - 1];
				if (top.kind === "list") {
					stack.pop();
					continue;
				}
				if (top.kind === "heading" && top.level >= level) {
					stack.pop();
					continue;
				}
				break;
			}

			const parentFrame = stack[stack.length - 1];
			const node = createNode(text, parentFrame.node, parentFrame.node.depth + 1);
			parentFrame.node.children.push(node);
			stack.push({ node, kind: "heading", level });
			continue;
		}

		const listMatch = LIST_RE.exec(line);
		if (listMatch) {
			const indent = Math.floor(listMatch[1].length / 2);
			const text = listMatch[2].trim();
			flushPendingContent(stack[stack.length - 1].node);

			while (stack.length > 1 && stack[stack.length - 1].kind === "list" && stack[stack.length - 1].level >= indent) {
				stack.pop();
			}

			const parentFrame = stack[stack.length - 1];
			const node = createNode(text, parentFrame.node, parentFrame.node.depth + 1);
			parentFrame.node.children.push(node);
			stack.push({ node, kind: "list", level: indent });
			continue;
		}

		pendingContent.push(line);
	}
	flushPendingContent(stack[stack.length - 1].node);

	computeSubtreeCounts(root);
	const byId = new Map<string, MindNode>();
	indexById(root, byId);
	applyMindmapDataToTree(byId, extractMindmapData(frontmatterRaw));

	return { root, byId, version: 1, frontmatterRaw, hasExplicitRootHeading };
}

function computeSubtreeCounts(node: MindNode): number {
	let count = 0;
	for (const child of node.children) {
		count += 1 + computeSubtreeCounts(child);
	}
	node.subtreeCount = count;
	return count;
}

function indexById(node: MindNode, byId: Map<string, MindNode>): void {
	byId.set(node.id, node);
	for (const child of node.children) indexById(child, byId);
}
