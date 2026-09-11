import { App, TFile } from "obsidian";

interface GNode {
	file: TFile;
	x: number;
	y: number;
	vx: number;
	vy: number;
	degree: number;
	/** Survives the current filter. */
	shown: boolean;
	/** Matches the query itself, rather than merely being linked to one. */
	hit: boolean;
}

interface GLink {
	a: GNode;
	b: GNode;
}

const MAX_ROWS = 200;

/**
 * The vault as a graph you can present from — the same idea as Obsidian's own
 * graph view, running inside the deck.
 *
 * The minimap covers this canvas; this covers the whole vault. Searching does
 * not just list matches, it filters the graph down to the matches *and the
 * notes they link to*, which is how you find the thing next to the thing you
 * remembered.
 */
export class Browser {
	private root: HTMLElement;
	private input: HTMLInputElement;
	private listEl: HTMLElement;
	private countEl: HTMLElement;
	private canvas: HTMLCanvasElement;
	private ctx: CanvasRenderingContext2D;

	private nodes: GNode[] = [];
	private links: GLink[] = [];
	private byPath = new Map<string, GNode>();
	private visible: GNode[] = [];

	private selected: GNode | null = null;
	private hover: GNode | null = null;
	private dragging: GNode | null = null;
	private panning = false;
	private last = { x: 0, y: 0 };

	private zoom = 1;
	private offset = { x: 0, y: 0 };
	private alpha = 0;
	private raf = 0;
	private open = false;

	constructor(container: HTMLElement, private app: App, private onOpen: (file: TFile) => void) {
		this.root = container.createDiv({ cls: "atl-browse" });
		this.root.addEventListener("click", (e) => {
			if (e.target === this.root) this.hide();
		});

		const panel = this.root.createDiv({ cls: "atl-browse-panel" });

		const head = panel.createDiv({ cls: "atl-browse-head" });
		this.input = head.createEl("input", { cls: "atl-browse-input" });
		this.input.type = "text";
		this.input.placeholder = "Filter the graph — matches and everything they link to…";
		this.input.addEventListener("input", () => this.filter());
		this.countEl = head.createDiv({ cls: "atl-browse-count" });
		const fit = head.createEl("button", { cls: "atl-browse-fit", text: "Fit" });
		fit.addEventListener("click", (e) => {
			e.stopPropagation();
			this.fit();
		});

		const cols = panel.createDiv({ cls: "atl-browse-cols" });
		this.listEl = cols.createDiv({ cls: "atl-browse-list" });
		const stage = cols.createDiv({ cls: "atl-browse-stage" });
		this.canvas = stage.createEl("canvas", { cls: "atl-browse-canvas" });
		this.ctx = this.canvas.getContext("2d") as CanvasRenderingContext2D;
		this.bindPointer();

		panel.createDiv({
			cls: "atl-browse-hint",
			text:
				"drag to pan · scroll to zoom · drag a node to pull it · click to select · " +
				"double-click or Enter to read it · Esc to close",
		});
	}

	get isOpen(): boolean {
		return this.open;
	}

	// ---------------------------------------------------------------- data

	private build(): void {
		const files = this.app.vault.getMarkdownFiles();
		this.nodes = [];
		this.byPath.clear();

		// A ring start beats random: the simulation untangles it far faster.
		files.forEach((file, i) => {
			const a = (i / files.length) * Math.PI * 2;
			const r = 180 + (i % 7) * 26;
			const node: GNode = {
				file,
				x: Math.cos(a) * r,
				y: Math.sin(a) * r,
				vx: 0,
				vy: 0,
				degree: 0,
				shown: true,
				hit: true,
			};
			this.nodes.push(node);
			this.byPath.set(file.path, node);
		});

		this.links = [];
		const seen = new Set<string>();
		for (const [source, targets] of Object.entries(this.app.metadataCache.resolvedLinks)) {
			const a = this.byPath.get(source);
			if (!a) continue;
			for (const target of Object.keys(targets)) {
				const b = this.byPath.get(target);
				if (!b || a === b) continue;
				const key = a.file.path < b.file.path ? `${a.file.path}|${b.file.path}` : `${b.file.path}|${a.file.path}`;
				if (seen.has(key)) continue;
				seen.add(key);
				this.links.push({ a, b });
				a.degree++;
				b.degree++;
			}
		}
	}

	private neighbours(node: GNode): Set<GNode> {
		const out = new Set<GNode>();
		for (const l of this.links) {
			if (l.a === node) out.add(l.b);
			else if (l.b === node) out.add(l.a);
		}
		return out;
	}

	/** Subsequence match, so "ndcp" finds "Northwind Depot Contracts Plan". */
	private score(file: TFile, query: string): number {
		const name = file.basename.toLowerCase();
		if (name.startsWith(query)) return 3;
		if (name.includes(query)) return 2;
		if (file.path.toLowerCase().includes(query)) return 1;
		let i = 0;
		for (const ch of file.path.toLowerCase()) {
			if (ch === query[i]) i++;
			if (i === query.length) return 0.5;
		}
		return -1;
	}

	private filter(): void {
		const query = this.input.value.trim().toLowerCase();

		if (!query) {
			for (const n of this.nodes) {
				n.shown = true;
				n.hit = true;
			}
		} else {
			const hits = this.nodes.filter((n) => this.score(n.file, query) >= 0);
			const keep = new Set<GNode>(hits);
			// The point of filtering a graph rather than a list: keep what the
			// matches are attached to, so context survives the search.
			for (const h of hits) for (const nb of this.neighbours(h)) keep.add(nb);
			for (const n of this.nodes) {
				n.shown = keep.has(n);
				n.hit = hits.includes(n);
			}
		}

		this.visible = this.nodes.filter((n) => n.shown);
		this.selected = this.visible.includes(this.selected as GNode) ? this.selected : this.visible[0] ?? null;
		this.renderList();
		this.kick();
	}

	private renderList(): void {
		this.listEl.empty();
		const hits = this.visible.filter((n) => n.hit);
		const rest = this.visible.filter((n) => !n.hit);
		const rows = [...hits, ...rest].slice(0, MAX_ROWS);

		this.countEl.setText(
			this.input.value.trim()
				? `${hits.length} matching · ${this.visible.length} shown of ${this.nodes.length}`
				: `${this.nodes.length} notes · ${this.links.length} links`
		);

		if (rows.length === 0) {
			this.listEl.createDiv({ cls: "atl-browse-empty", text: "Nothing matches." });
			return;
		}

		for (const node of rows) {
			const row = this.listEl.createDiv({ cls: "atl-browse-row" });
			row.toggleClass("is-cursor", node === this.selected);
			row.toggleClass("is-linked", !node.hit);
			row.createDiv({ cls: "atl-browse-name", text: node.file.basename });
			const folder = node.file.parent?.path ?? "";
			if (folder && folder !== "/") row.createDiv({ cls: "atl-browse-path", text: folder });
			row.addEventListener("click", (e) => {
				e.stopPropagation();
				this.select(node, true);
			});
			row.addEventListener("dblclick", (e) => {
				e.stopPropagation();
				this.choose();
			});
		}
	}

	// --------------------------------------------------------- simulation

	private kick(): void {
		this.alpha = 1;
		if (!this.raf) this.raf = requestAnimationFrame(() => this.tick());
	}

	private tick(): void {
		this.raf = 0;
		if (!this.open) return;

		if (this.alpha > 0.005) {
			this.step();
			this.alpha *= 0.975;
		}
		this.draw();
		this.raf = requestAnimationFrame(() => this.tick());
	}

	private step(): void {
		const nodes = this.visible;
		const n = nodes.length;
		if (n === 0) return;

		// Repulsion through a uniform grid: comparing all pairs is fine at a
		// hundred notes and quadratic misery at a thousand.
		const CELL = 90;
		const grid = new Map<string, GNode[]>();
		for (const node of nodes) {
			const key = `${Math.floor(node.x / CELL)},${Math.floor(node.y / CELL)}`;
			const bucket = grid.get(key);
			if (bucket) bucket.push(node);
			else grid.set(key, [node]);
		}

		const repel = 2400 * this.alpha;
		for (const node of nodes) {
			const gx = Math.floor(node.x / CELL);
			const gy = Math.floor(node.y / CELL);
			for (let dx = -1; dx <= 1; dx++) {
				for (let dy = -1; dy <= 1; dy++) {
					for (const other of grid.get(`${gx + dx},${gy + dy}`) ?? []) {
						if (other === node) continue;
						let ex = node.x - other.x;
						let ey = node.y - other.y;
						let d2 = ex * ex + ey * ey;
						if (d2 > CELL * CELL * 4) continue;
						if (d2 < 0.01) {
							ex = Math.random() - 0.5;
							ey = Math.random() - 0.5;
							d2 = 0.01;
						}
						const f = repel / d2;
						node.vx += ex * f;
						node.vy += ey * f;
					}
				}
			}
			// Gentle pull to the middle, so detached notes do not drift away.
			node.vx -= node.x * 0.0016 * this.alpha;
			node.vy -= node.y * 0.0016 * this.alpha;
		}

		const REST = 96;
		for (const link of this.links) {
			if (!link.a.shown || !link.b.shown) continue;
			const ex = link.b.x - link.a.x;
			const ey = link.b.y - link.a.y;
			const d = Math.hypot(ex, ey) || 0.01;
			const f = ((d - REST) / d) * 0.045 * this.alpha;
			const fx = ex * f;
			const fy = ey * f;
			link.a.vx += fx;
			link.a.vy += fy;
			link.b.vx -= fx;
			link.b.vy -= fy;
		}

		for (const node of nodes) {
			if (node === this.dragging) continue;
			node.vx *= 0.82;
			node.vy *= 0.82;
			node.x += Math.max(-18, Math.min(18, node.vx));
			node.y += Math.max(-18, Math.min(18, node.vy));
		}
	}

	// ------------------------------------------------------------ drawing

	private radius(node: GNode): number {
		return 4 + Math.min(9, Math.sqrt(node.degree) * 2.6);
	}

	private css(name: string, fallback: string): string {
		const v = getComputedStyle(this.root).getPropertyValue(name).trim();
		return v || fallback;
	}

	private resize(): void {
		const dpr = Math.min(window.devicePixelRatio || 1, 2);
		const w = this.canvas.clientWidth || 800;
		const h = this.canvas.clientHeight || 600;
		this.canvas.width = Math.round(w * dpr);
		this.canvas.height = Math.round(h * dpr);
		this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
	}

	private draw(): void {
		this.resize();
		const ctx = this.ctx;
		const w = this.canvas.clientWidth;
		const h = this.canvas.clientHeight;
		ctx.clearRect(0, 0, w, h);

		const accent = this.css("--atl-accent", "#5b8def");
		const faint = this.css("--text-faint", "#888");
		const muted = this.css("--text-muted", "#aaa");
		const normal = this.css("--text-normal", "#eee");
		const bgNode = this.css("--background-secondary", "#2a2a2a");

		ctx.save();
		ctx.translate(w / 2 + this.offset.x, h / 2 + this.offset.y);
		ctx.scale(this.zoom, this.zoom);

		ctx.lineWidth = 1 / this.zoom;
		ctx.strokeStyle = faint;
		ctx.globalAlpha = 0.35;
		ctx.beginPath();
		for (const link of this.links) {
			if (!link.a.shown || !link.b.shown) continue;
			ctx.moveTo(link.a.x, link.a.y);
			ctx.lineTo(link.b.x, link.b.y);
		}
		ctx.stroke();
		ctx.globalAlpha = 1;

		// Links from the selected note stand out, the way the local graph does.
		if (this.selected) {
			ctx.strokeStyle = accent;
			ctx.globalAlpha = 0.9;
			ctx.lineWidth = 1.8 / this.zoom;
			ctx.beginPath();
			for (const link of this.links) {
				if (!link.a.shown || !link.b.shown) continue;
				if (link.a !== this.selected && link.b !== this.selected) continue;
				ctx.moveTo(link.a.x, link.a.y);
				ctx.lineTo(link.b.x, link.b.y);
			}
			ctx.stroke();
			ctx.globalAlpha = 1;
		}

		for (const node of this.visible) {
			const r = this.radius(node);
			const isPicked = node === this.selected || node === this.hover;
			ctx.beginPath();
			ctx.arc(node.x, node.y, r, 0, Math.PI * 2);
			ctx.fillStyle = isPicked ? accent : node.hit ? bgNode : bgNode;
			ctx.globalAlpha = node.hit ? 1 : 0.55;
			ctx.fill();
			ctx.lineWidth = (isPicked ? 2.4 : 1.4) / this.zoom;
			ctx.strokeStyle = isPicked ? accent : node.hit ? muted : faint;
			ctx.stroke();
			ctx.globalAlpha = 1;
		}

		// Labels only where they can be read: crowding them is worse than none.
		const labelAll = this.zoom > 0.85 || this.visible.length <= 40;
		ctx.textAlign = "center";
		ctx.textBaseline = "top";
		for (const node of this.visible) {
			const isPicked = node === this.selected || node === this.hover;
			if (!labelAll && !isPicked && !(node.hit && this.input.value.trim())) continue;
			ctx.font = `${isPicked ? 600 : 400} ${12 / this.zoom}px var(--font-interface), sans-serif`;
			ctx.fillStyle = isPicked ? normal : muted;
			ctx.globalAlpha = isPicked ? 1 : 0.85;
			const name = node.file.basename;
			ctx.fillText(
				name.length > 26 ? `${name.slice(0, 25)}…` : name,
				node.x,
				node.y + this.radius(node) + 4 / this.zoom
			);
			ctx.globalAlpha = 1;
		}

		ctx.restore();
	}

	// ----------------------------------------------------------- pointer

	private toWorld(e: MouseEvent): { x: number; y: number } {
		const rect = this.canvas.getBoundingClientRect();
		return {
			x: (e.clientX - rect.left - rect.width / 2 - this.offset.x) / this.zoom,
			y: (e.clientY - rect.top - rect.height / 2 - this.offset.y) / this.zoom,
		};
	}

	private nodeAt(e: MouseEvent): GNode | null {
		const p = this.toWorld(e);
		let best: GNode | null = null;
		let bestD = Infinity;
		for (const node of this.visible) {
			const d = Math.hypot(node.x - p.x, node.y - p.y);
			const r = this.radius(node) + 8;
			if (d < r && d < bestD) {
				best = node;
				bestD = d;
			}
		}
		return best;
	}

	private bindPointer(): void {
		this.canvas.addEventListener("mousedown", (e) => {
			e.stopPropagation();
			const node = this.nodeAt(e);
			if (node) {
				this.dragging = node;
				this.select(node, false);
			} else {
				this.panning = true;
			}
			this.last = { x: e.clientX, y: e.clientY };
		});

		this.canvas.addEventListener("mousemove", (e) => {
			if (this.dragging) {
				const p = this.toWorld(e);
				this.dragging.x = p.x;
				this.dragging.y = p.y;
				this.dragging.vx = 0;
				this.dragging.vy = 0;
				this.kick();
			} else if (this.panning) {
				this.offset.x += e.clientX - this.last.x;
				this.offset.y += e.clientY - this.last.y;
				this.last = { x: e.clientX, y: e.clientY };
			} else {
				const was = this.hover;
				this.hover = this.nodeAt(e);
				this.canvas.toggleClass("is-over", !!this.hover);
				if (was !== this.hover) this.draw();
			}
		});

		const release = () => {
			this.dragging = null;
			this.panning = false;
		};
		this.canvas.addEventListener("mouseup", release);
		this.canvas.addEventListener("mouseleave", release);

		this.canvas.addEventListener("dblclick", (e) => {
			e.stopPropagation();
			const node = this.nodeAt(e);
			if (node) {
				this.select(node, true);
				this.choose();
			}
		});

		this.canvas.addEventListener(
			"wheel",
			(e) => {
				e.preventDefault();
				e.stopPropagation();
				const factor = Math.exp(-e.deltaY * 0.0014);
				this.zoom = Math.max(0.15, Math.min(4, this.zoom * factor));
				this.draw();
			},
			{ passive: false }
		);
	}

	private select(node: GNode, syncList: boolean): void {
		this.selected = node;
		if (syncList) this.renderList();
		else {
			for (const row of Array.from(this.listEl.children)) {
				const name = row.querySelector(".atl-browse-name")?.textContent;
				row.toggleClass("is-cursor", name === node.file.basename);
			}
		}
		this.draw();
	}

	private fit(): void {
		if (this.visible.length === 0) return;
		const xs = this.visible.map((n) => n.x);
		const ys = this.visible.map((n) => n.y);
		const w = Math.max(...xs) - Math.min(...xs) || 1;
		const h = Math.max(...ys) - Math.min(...ys) || 1;
		const cw = this.canvas.clientWidth || 800;
		const ch = this.canvas.clientHeight || 600;
		this.zoom = Math.max(0.15, Math.min(2.4, Math.min(cw / (w + 160), ch / (h + 160))));
		this.offset = {
			x: -((Math.min(...xs) + w / 2) * this.zoom),
			y: -((Math.min(...ys) + h / 2) * this.zoom),
		};
		this.draw();
	}

	// -------------------------------------------------------------- api

	show(): void {
		this.build();
		this.input.value = "";
		this.open = true;
		this.root.addClass("is-open");
		this.filter();
		window.setTimeout(() => {
			this.input.focus();
			this.fit();
		}, 30);
		// A short settle before the first look, so it does not open as a knot.
		window.setTimeout(() => this.fit(), 900);
	}

	hide(): void {
		this.open = false;
		this.root.removeClass("is-open");
		this.input.blur();
		if (this.raf) cancelAnimationFrame(this.raf);
		this.raf = 0;
	}

	toggle(): void {
		if (this.open) this.hide();
		else this.show();
	}

	move(delta: number): void {
		const rows = Array.from(this.listEl.children);
		if (rows.length === 0) return;
		const names = rows.map((r) => r.querySelector(".atl-browse-name")?.textContent ?? "");
		let i = this.selected ? names.indexOf(this.selected.file.basename) : -1;
		i = (i + delta + names.length) % names.length;
		const node = this.visible.find((n) => n.file.basename === names[i]);
		if (node) {
			this.select(node, true);
			this.listEl.children[i]?.scrollIntoView({ block: "nearest" });
		}
	}

	choose(): void {
		if (!this.selected) return;
		const file = this.selected.file;
		this.hide();
		this.onOpen(file);
	}
}
