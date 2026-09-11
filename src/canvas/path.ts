import { CanvasData, CanvasEdge, CanvasNode, Scene, Stop } from "../types";
import { boundsOf, buildGroupMap, outsideCode, rectOf } from "./parse";

/**
 * Edges carry the running order. A label that starts with a number wins
 * ("1.", "2 - then this"); otherwise we fall back to reading order of the
 * target card, so an unlabelled canvas still presents sensibly.
 */
function edgeRank(edge: CanvasEdge, target: CanvasNode | undefined): [number, number, number] {
	const m = edge.label?.trim().match(/^(\d+(?:\.\d+)?)/);
	const explicit = m ? parseFloat(m[1]) : Number.POSITIVE_INFINITY;
	const t = target ? rectOf(target) : { x: 0, y: 0, width: 0, height: 0 };
	return [explicit, t.y, t.x];
}

function compareRank(a: [number, number, number], b: [number, number, number]): number {
	return a[0] - b[0] || a[1] - b[1] || a[2] - b[2];
}

/**
 * Pick where the talk starts: an explicitly labelled node, else the only node
 * with outgoing edges and no incoming ones, else the top-left card.
 */
function pickStart(slides: CanvasNode[], edges: CanvasEdge[]): CanvasNode | undefined {
	if (slides.length === 0) return undefined;

	const tagged = slides.find((n) =>
		/(^|\n)\s*(#start\b|<!--\s*start\s*-->)/i.test(n.text ?? "")
	);
	if (tagged) return tagged;

	const incoming = new Set(edges.map((e) => e.toNode));
	const outgoing = new Set(edges.map((e) => e.fromNode));
	const roots = slides.filter((n) => !incoming.has(n.id) && outgoing.has(n.id));
	if (roots.length > 0) {
		return roots.sort((a, b) => rectOf(a).y - rectOf(b).y || rectOf(a).x - rectOf(b).x)[0];
	}

	return [...slides].sort((a, b) => rectOf(a).y - rectOf(b).y || rectOf(a).x - rectOf(b).x)[0];
}

/** A card marked `#deck` is the deck's title block, not a slide. */
const DECK_CARD = /(^|\n)[ \t]*#deck[ \t]*(\n|$)/;

/**
 * `key: value` lines from the #deck card.
 *
 * The header belongs to the canvas rather than to a global setting — two
 * decks want two different titles, and the person writing the talk should not
 * have to go into plugin settings to say so.
 */
function readDeckMeta(nodes: CanvasNode[]): Record<string, string> {
	const card = nodes.find(
		(n) => n.type === "text" && DECK_CARD.test(outsideCode(n.text ?? ""))
	);
	if (!card) return {};
	const meta: Record<string, string> = {};
	const body: string[] = [];
	// Anything that is not a key becomes header text, so the card needs a way to
	// carry a note to itself. %%…%% is what the rest of Atlas already uses.
	const source = (card.text ?? "").replace(/%%[\s\S]*?%%/g, "");
	for (const line of source.split("\n")) {
		if (/^[ \t]*#deck[ \t]*$/.test(line)) continue;
		const m = line.match(/^[ \t]*([A-Za-z][\w -]*)[ \t]*:[ \t]*(.+?)[ \t]*$/);
		if (m) {
			// Keys are matched loosely, so `logo corner:` and `logo-corner:` agree.
			meta[m[1].trim().toLowerCase().replace(/[ -]/g, "")] = m[2];
			continue;
		}
		body.push(line);
	}
	// Anything that is not a key is the header's own content, as markdown.
	const rest = body.join("\n").trim();
	if (rest) meta.__body = rest;
	return meta;
}

/**
 * Which talk a card belongs to.
 *
 * `#skip-exec` leaves it out of the exec talk; `#only-exec` keeps it for that
 * talk alone. No tags at all means every talk, which is what most cards want.
 */
function inVariant(node: CanvasNode, variant: string): boolean {
	const text = outsideCode(node.text ?? "");
	const only = [...text.matchAll(/(^|\n)[ \t]*#only-([\w-]+)\b/gi)].map((m) => m[2].toLowerCase());
	const skip = [...text.matchAll(/(^|\n)[ \t]*#skip-([\w-]+)\b/gi)].map((m) => m[2].toLowerCase());
	const v = variant.toLowerCase();
	if (skip.includes(v)) return false;
	if (only.length > 0 && !only.includes(v)) return false;
	return true;
}

/** The variant names a canvas mentions anywhere, for the picker. */
/** `variant:` on the #deck card, when it names a default. */
export function readDeckVariant(data: CanvasData): string {
	const card = data.nodes.find(
		(n) => n.type === "text" && DECK_CARD.test(outsideCode(n.text ?? ""))
	);
	if (!card) return "";
	const m = outsideCode(card.text ?? "").match(/^[ \t]*variant[ \t]*:[ \t]*(.+?)[ \t]*$/mi);
	return m ? m[1].toLowerCase() : "";
}

export function variantsIn(data: CanvasData): string[] {
	const found = new Set<string>();
	for (const node of data.nodes) {
		for (const m of outsideCode(node.text ?? "").matchAll(/(^|\n)[ \t]*#(?:skip|only)-([\w-]+)\b/gi)) {
			found.add(m[2].toLowerCase());
		}
	}
	return [...found].sort();
}

export function buildScene(
	data: CanvasData,
	sectionOverviews: boolean,
	variant = ""
): Scene {
	const meta = readDeckMeta(data.nodes);
	// The title block is not a stop, and must not show up on the map either.
	const slides = data.nodes.filter(
		(n) =>
			n.type !== "group" &&
			!(n.type === "text" && DECK_CARD.test(outsideCode(n.text ?? "")))
	);
	const groups = data.nodes.filter((n) => n.type === "group");
	const groupOf = buildGroupMap(data.nodes);
	const byId = new Map(data.nodes.map((n) => [n.id, n]));

	const out = new Map<string, CanvasEdge[]>();
	for (const e of data.edges) {
		if (!out.has(e.fromNode)) out.set(e.fromNode, []);
		out.get(e.fromNode)!.push(e);
	}
	for (const [, list] of out) {
		list.sort((a, b) =>
			compareRank(edgeRank(a, byId.get(a.toNode)), edgeRank(b, byId.get(b.toNode)))
		);
	}

	const stops: Stop[] = [];
	const visited = new Set<string>();
	const openedGroups = new Set<string>();

	const push = (node: CanvasNode, depth: number) => {
		const group = groupOf.get(node.id);
		// Entering a new section: zoom out to frame the whole group first.
		if (sectionOverviews && group && !openedGroups.has(group.id)) {
			openedGroups.add(group.id);
			stops.push({ kind: "group", node: group, group, depth: Math.max(0, depth - 1) });
		}
		stops.push({ kind: "node", node, group, depth });
	};

	// Depth-first: a branch of the mind map is told to its end before we
	// back out and take the next one. That is how people actually talk.
	const walk = (node: CanvasNode, depth: number) => {
		if (visited.has(node.id)) return;
		visited.add(node.id);
		// Left out of this talk, but still a junction: its children are reached
		// through it, so skipping it must not break the chain.
		if (variant && !inVariant(node, variant)) {
			for (const edge of out.get(node.id) ?? []) {
				const next = byId.get(edge.toNode);
				if (next && next.type !== "group") walk(next, depth);
			}
			return;
		}
		push(node, depth);
		for (const edge of out.get(node.id) ?? []) {
			const next = byId.get(edge.toNode);
			if (next && next.type !== "group") walk(next, depth + 1);
		}
	};

	const start = pickStart(slides, data.edges);
	if (start) walk(start, 0);

	// Anything the edges never reached still belongs in the deck, in reading order.
	const orphans = slides
		.filter((n) => !visited.has(n.id) && (!variant || inVariant(n, variant)))
		.sort((a, b) => rectOf(a).y - rectOf(b).y || rectOf(a).x - rectOf(b).x);
	for (const n of orphans) walk(n, 0);

	return {
		meta,
		data,
		slides,
		groups,
		stops,
		bounds: boundsOf(data.nodes),
		groupOf,
	};
}
