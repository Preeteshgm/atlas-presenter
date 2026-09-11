import { CanvasData, CanvasNode, Rect } from "../types";

export function parseCanvas(raw: string): CanvasData {
	let json: unknown;
	try {
		json = JSON.parse(raw);
	} catch (e) {
		// Keep the cause: "could not be parsed" alone tells nobody which
		// character on which line was the problem.
		throw new Error("This canvas file could not be parsed as JSON.", { cause: e });
	}
	const data = json as Partial<CanvasData>;
	return {
		nodes: Array.isArray(data.nodes) ? data.nodes : [],
		edges: Array.isArray(data.edges) ? data.edges : [],
	};
}

/**
 * Card text with fenced code blocks removed.
 *
 * `#deck`, `#start` and tag lines are markers, but a card explaining them shows
 * them as code. Scanning the raw text makes such a card vanish from its own
 * deck, which is a baffling failure to debug.
 */
export function outsideCode(md: string): string {
	// Built from a string so the backreference survives: a block closes on
	// the same fence it opened with, not on the next blank line.
	const FENCE = new RegExp("^[ \\t]*(`{3,}|~{3,})[\\s\\S]*?^[ \\t]*\\1[ \\t]*$", "gm");
	return md.replace(FENCE, "");
}

export function rectOf(n: Rect): Rect {
	// Canvas allows negative width/height in some editors; normalise.
	const x = n.width < 0 ? n.x + n.width : n.x;
	const y = n.height < 0 ? n.y + n.height : n.y;
	return { x, y, width: Math.abs(n.width), height: Math.abs(n.height) };
}

export function contains(outer: Rect, inner: Rect): boolean {
	const o = rectOf(outer);
	const i = rectOf(inner);
	return (
		i.x >= o.x &&
		i.y >= o.y &&
		i.x + i.width <= o.x + o.width &&
		i.y + i.height <= o.y + o.height
	);
}

export function area(r: Rect): number {
	const n = rectOf(r);
	return n.width * n.height;
}

export function boundsOf(nodes: Rect[]): Rect {
	if (nodes.length === 0) return { x: 0, y: 0, width: 1000, height: 1000 };
	let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
	for (const raw of nodes) {
		const n = rectOf(raw);
		minX = Math.min(minX, n.x);
		minY = Math.min(minY, n.y);
		maxX = Math.max(maxX, n.x + n.width);
		maxY = Math.max(maxY, n.y + n.height);
	}
	return { x: minX, y: minY, width: maxX - minX, height: maxY - minY };
}

/**
 * Map every non-group node to the *smallest* group that geometrically contains
 * it. Canvas has no parent pointers, so containment is the only signal we get.
 */
export function buildGroupMap(nodes: CanvasNode[]): Map<string, CanvasNode> {
	const groups = nodes.filter((n) => n.type === "group");
	const map = new Map<string, CanvasNode>();
	for (const node of nodes) {
		if (node.type === "group") continue;
		let best: CanvasNode | undefined;
		for (const g of groups) {
			if (!contains(g, node)) continue;
			if (!best || area(g) < area(best)) best = g;
		}
		if (best) map.set(node.id, best);
	}
	return map;
}
