import { App } from "obsidian";
import { Scene } from "../types";
import { rectOf } from "../canvas/parse";
import { thumbnailFor, titleOf } from "./render";

const NS = "http://www.w3.org/2000/svg";

/** Naive greedy wrap. Card titles are short; a full text measurer is overkill. */
function wrap(text: string, maxChars: number, maxLines: number): string[] {
	const words = text.split(/\s+/).filter(Boolean);
	const lines: string[] = [];
	let line = "";
	for (const word of words) {
		const candidate = line ? `${line} ${word}` : word;
		if (candidate.length <= maxChars) {
			line = candidate;
			continue;
		}
		if (line) lines.push(line);
		line = word;
		if (lines.length === maxLines) break;
	}
	if (line && lines.length < maxLines) lines.push(line);
	if (lines.length === maxLines) {
		const last = lines[maxLines - 1];
		if (last.length > maxChars - 1 || words.join(" ").length > lines.join(" ").length) {
			lines[maxLines - 1] = last.slice(0, Math.max(1, maxChars - 1)).trimEnd() + "…";
		}
	}
	return lines;
}

/**
 * The whole point of the plugin: the map you authored is also the map you
 * navigate. Someone asks a question three branches away, you press M, click
 * the node, answer it, then Backspace back to where you were.
 *
 * Boxes alone are not enough to choose from — each card carries its title, its
 * position in the running order, and a thumbnail when it is an image.
 */
export class Minimap {
	private root: HTMLElement;
	private svg: SVGSVGElement;
	private cells = new Map<string, SVGRectElement>();
	private open = false;

	constructor(
		container: HTMLElement,
		private app: App,
		private scene: Scene,
		private onPick: (stopIndex: number) => void
	) {
		this.root = container.createDiv({ cls: "atl-minimap" });
		this.root.addEventListener("click", (e) => {
			if (e.target === this.root) this.hide();
		});

		const b = rectOf(this.scene.bounds);
		const m = Math.max(b.width, b.height) * 0.05;
		this.svg = document.createElementNS(NS, "svg");
		this.svg.setAttribute(
			"viewBox",
			`${b.x - m} ${b.y - m} ${b.width + m * 2} ${b.height + m * 2}`
		);
		this.svg.addClass("atl-minimap-svg");
		// The svg covers the backdrop, so clicking empty space inside it has to
		// close too, or the overlay feels stuck.
		this.svg.addEventListener("click", (e) => {
			if (e.target === this.svg) this.hide();
		});
		this.root.appendChild(this.svg);

		this.draw();
		this.root.createDiv({
			cls: "atl-minimap-hint",
			text: "Click a card to fly there · Backspace returns · M or Esc closes",
		});
	}

	private get unit(): number {
		return Math.max(rectOf(this.scene.bounds).width, 1) * 0.0016;
	}

	private draw(): void {
		const stroke = Math.max(this.unit, 1);

		for (const g of this.scene.groups) {
			const r = rectOf(g);
			const el = document.createElementNS(NS, "rect");
			el.setAttribute("x", String(r.x));
			el.setAttribute("y", String(r.y));
			el.setAttribute("width", String(r.width));
			el.setAttribute("height", String(r.height));
			el.setAttribute("rx", String(stroke * 12));
			el.setAttribute("stroke-width", String(stroke));
			el.addClass("atl-mm-group");
			this.svg.appendChild(el);

			if (g.label) {
				const label = document.createElementNS(NS, "text");
				label.setAttribute("x", String(r.x + stroke * 8));
				label.setAttribute("y", String(r.y - stroke * 8));
				label.setAttribute("font-size", String(stroke * 22));
				label.addClass("atl-mm-grouplabel");
				label.textContent = g.label;
				this.svg.appendChild(label);
			}
		}

		const byId = new Map(this.scene.data.nodes.map((n) => [n.id, n]));
		for (const e of this.scene.data.edges) {
			const a = byId.get(e.fromNode);
			const b = byId.get(e.toNode);
			if (!a || !b) continue;
			const ra = rectOf(a);
			const rb = rectOf(b);
			const line = document.createElementNS(NS, "line");
			line.setAttribute("x1", String(ra.x + ra.width / 2));
			line.setAttribute("y1", String(ra.y + ra.height / 2));
			line.setAttribute("x2", String(rb.x + rb.width / 2));
			line.setAttribute("y2", String(rb.y + rb.height / 2));
			line.setAttribute("stroke-width", String(stroke * 1.6));
			line.addClass("atl-mm-edge");
			this.svg.appendChild(line);
		}

		let order = 0;
		this.scene.stops.forEach((stop, i) => {
			if (stop.kind !== "node") return;
			order++;
			if (this.cells.has(stop.node.id)) return;
			this.drawCard(stop.node.id, i, order);
		});
	}

	private drawCard(nodeId: string, stopIndex: number, order: number): void {
		const node = this.scene.data.nodes.find((n) => n.id === nodeId);
		if (!node) return;
		const r = rectOf(node);
		const stroke = Math.max(this.unit, 1);

		const group = document.createElementNS(NS, "g");
		group.addClass("atl-mm-card");
		group.addEventListener("click", (ev) => {
			ev.stopPropagation();
			this.hide();
			this.onPick(stopIndex);
		});

		const box = document.createElementNS(NS, "rect");
		box.setAttribute("x", String(r.x));
		box.setAttribute("y", String(r.y));
		box.setAttribute("width", String(r.width));
		box.setAttribute("height", String(r.height));
		box.setAttribute("rx", String(Math.min(r.width, r.height) * 0.05));
		box.setAttribute("stroke-width", String(stroke));
		box.addClass("atl-mm-node");
		if (node.color) box.setAttribute("data-color", node.color);
		group.appendChild(box);

		// An image card is unmistakable from its own picture; text cards get
		// their title instead.
		const thumb = thumbnailFor(this.app, node);
		if (thumb) {
			const clipId = `atl-clip-${node.id}`;
			const clip = document.createElementNS(NS, "clipPath");
			clip.setAttribute("id", clipId);
			const clipRect = document.createElementNS(NS, "rect");
			clipRect.setAttribute("x", String(r.x));
			clipRect.setAttribute("y", String(r.y));
			clipRect.setAttribute("width", String(r.width));
			clipRect.setAttribute("height", String(r.height));
			clipRect.setAttribute("rx", String(Math.min(r.width, r.height) * 0.05));
			clip.appendChild(clipRect);
			group.appendChild(clip);

			const img = document.createElementNS(NS, "image");
			img.setAttribute("href", thumb);
			img.setAttribute("x", String(r.x));
			img.setAttribute("y", String(r.y));
			img.setAttribute("width", String(r.width));
			img.setAttribute("height", String(r.height));
			img.setAttribute("preserveAspectRatio", "xMidYMid slice");
			img.setAttribute("clip-path", `url(#${clipId})`);
			img.addClass("atl-mm-thumb");
			group.appendChild(img);
		} else {
			const size = Math.max(Math.min(r.height * 0.15, r.width * 0.08, 44), 9);
			const lines = wrap(titleOf(node), Math.floor(r.width / (size * 0.54)), 3);
			const text = document.createElementNS(NS, "text");
			text.setAttribute("x", String(r.x + r.width / 2));
			text.setAttribute("text-anchor", "middle");
			text.setAttribute("font-size", String(size));
			text.addClass("atl-mm-label");
			const top = r.y + r.height / 2 - ((lines.length - 1) * size * 1.25) / 2 + size * 0.34;
			lines.forEach((line, i) => {
				const tspan = document.createElementNS(NS, "tspan");
				tspan.setAttribute("x", String(r.x + r.width / 2));
				tspan.setAttribute("y", String(top + i * size * 1.25));
				tspan.textContent = line;
				text.appendChild(tspan);
			});
			group.appendChild(text);
		}

		// Running order, so the map doubles as a rehearsal aid.
		const badgeR = Math.max(Math.min(r.width, r.height) * 0.07, stroke * 7);
		const badge = document.createElementNS(NS, "circle");
		badge.setAttribute("cx", String(r.x + badgeR * 1.35));
		badge.setAttribute("cy", String(r.y + badgeR * 1.35));
		badge.setAttribute("r", String(badgeR));
		badge.addClass("atl-mm-badge");
		group.appendChild(badge);

		const num = document.createElementNS(NS, "text");
		num.setAttribute("x", String(r.x + badgeR * 1.35));
		num.setAttribute("y", String(r.y + badgeR * 1.35 + badgeR * 0.36));
		num.setAttribute("text-anchor", "middle");
		num.setAttribute("font-size", String(badgeR * 1.05));
		num.addClass("atl-mm-badgetext");
		num.textContent = String(order);
		group.appendChild(num);

		this.svg.appendChild(group);
		this.cells.set(node.id, box);
	}

	setCurrent(nodeId: string | undefined): void {
		for (const [id, el] of this.cells) el.toggleClass("is-current", id === nodeId);
	}

	get isOpen(): boolean {
		return this.open;
	}

	show(): void {
		this.open = true;
		this.root.addClass("is-open");
	}

	hide(): void {
		this.open = false;
		this.root.removeClass("is-open");
	}

	toggle(): void {
		if (this.open) this.hide();
		else this.show();
	}
}
