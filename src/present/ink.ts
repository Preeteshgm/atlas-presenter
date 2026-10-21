/**
 * Drawing on a frozen card (D).
 *
 * A canvas laid over the card itself, not the screen, so the ink stays where it
 * was put if the window resizes or the camera moves. Points are kept in the
 * card's own units and redrawn at whatever size the card is shown, so the
 * strokes stay sharp and undo is just "drop the last one and redraw".
 *
 * The deck owns what happens to the ink when drawing ends — saved into the
 * card's note in Obsidian, simply let go in an exported file — so this class
 * only draws, and says when the person is done.
 */

interface Stroke {
	color: string;
	width: number;
	alpha: number;
	erase: boolean;
	points: [number, number, number][];
}

type Tool = "pen" | "red" | "mark" | "erase";

export interface InkOptions {
	/** The deck's accent, for the default pen. */
	accent: string;
	/** True in Obsidian, where finishing saves; false shows only Done. */
	saves: boolean;
	/** Called when the person finishes: keep the ink, or throw it away. */
	onDone: (keep: boolean) => void;
}

const WIDTH: Record<Tool, number> = { pen: 3, red: 3, mark: 16, erase: 22 };

export class Ink {
	readonly canvas: HTMLCanvasElement;
	private bar: HTMLElement;
	private strokes: Stroke[] = [];
	private live: Stroke | null = null;
	private tool: Tool = "pen";
	private ro: ResizeObserver | null = null;

	constructor(
		readonly card: HTMLElement,
		host: HTMLElement,
		private readonly opts: InkOptions
	) {
		const doc = card.ownerDocument;
		this.canvas = doc.createElement("canvas");
		this.canvas.className = "atl-ink";
		card.appendChild(this.canvas);

		this.bar = doc.createElement("div");
		this.bar.className = "atl-ink-bar";
		const tools: [Tool, string, string][] = [
			["pen", "Pen", opts.accent],
			["red", "Red pen", "#B3402F"],
			["mark", "Highlighter", "#D4AF37"],
			["erase", "Eraser", ""],
		];
		for (const [tool, label, colour] of tools) {
			const b = doc.createElement("button");
			b.type = "button";
			b.className = `atl-ink-tool${tool === this.tool ? " is-on" : ""}`;
			b.dataset.tool = tool;
			b.title = label;
			b.setAttribute("aria-label", label);
			if (colour) b.style.setProperty("--ink", colour);
			b.addEventListener("click", (e) => {
				e.stopPropagation();
				this.tool = tool;
				for (const t of Array.from(this.bar.querySelectorAll(".atl-ink-tool"))) {
					t.classList.toggle("is-on", (t as HTMLElement).dataset.tool === tool);
				}
			});
			this.bar.appendChild(b);
		}
		this.button("Undo", "atl-ink-act", () => this.undo());
		this.button("Clear", "atl-ink-act", () => this.clear());
		this.bar.appendChild(doc.createElement("i"));
		if (opts.saves) {
			this.button("Discard", "atl-ink-act", () => opts.onDone(false));
			this.button("Save", "atl-ink-act is-main", () => opts.onDone(true));
		} else {
			this.button("Done", "atl-ink-act is-main", () => opts.onDone(false));
		}
		host.appendChild(this.bar);

		this.canvas.addEventListener("pointerdown", (e) => this.down(e));
		this.canvas.addEventListener("pointermove", (e) => this.move(e));
		this.canvas.addEventListener("pointerup", (e) => this.up(e));
		this.canvas.addEventListener("pointercancel", (e) => this.up(e));
		// The card must not answer while it is being drawn on.
		this.canvas.addEventListener("click", (e) => e.stopPropagation());

		const View = (doc.defaultView as unknown as { ResizeObserver?: typeof ResizeObserver }).ResizeObserver;
		if (View) {
			this.ro = new View(() => this.fit());
			this.ro.observe(card);
		}
		this.fit();
	}

	get hasInk(): boolean {
		return this.strokes.some((s) => !s.erase);
	}

	undo(): void {
		this.strokes.pop();
		this.redraw();
	}

	clear(): void {
		this.strokes = [];
		this.redraw();
	}

	/** Hide the toolbar, so a capture of the card shows only the card and its ink. */
	hideBar(): void {
		this.bar.classList.add("is-hidden");
	}

	/**
	 * The ink on the card's own background, for when the screen itself cannot
	 * be captured. Not the card's content — only what was drawn, on its paper.
	 */
	async onPaper(): Promise<ArrayBuffer | null> {
		const doc = this.card.ownerDocument;
		const out = doc.createElement("canvas");
		out.width = this.canvas.width;
		out.height = this.canvas.height;
		const ctx = out.getContext("2d");
		if (!ctx) return null;
		const view = doc.defaultView;
		ctx.fillStyle = (view && view.getComputedStyle(this.card).backgroundColor) || "#ffffff";
		ctx.fillRect(0, 0, out.width, out.height);
		ctx.drawImage(this.canvas, 0, 0);
		const blob = await new Promise<Blob | null>((ok) => out.toBlob(ok, "image/png"));
		return blob ? await blob.arrayBuffer() : null;
	}

	destroy(): void {
		this.ro?.disconnect();
		this.canvas.remove();
		this.bar.remove();
	}

	private button(label: string, cls: string, act: () => void): void {
		const b = this.card.ownerDocument.createElement("button");
		b.type = "button";
		b.className = cls;
		b.textContent = label;
		b.addEventListener("click", (e) => {
			e.stopPropagation();
			act();
		});
		this.bar.appendChild(b);
	}

	/** Size the canvas to the card as it is shown, so the ink is drawn sharp. */
	private fit(): void {
		const box = this.card.getBoundingClientRect();
		const ratio = this.card.ownerDocument.defaultView?.devicePixelRatio ?? 1;
		const w = Math.max(1, Math.round(box.width * ratio));
		const h = Math.max(1, Math.round(box.height * ratio));
		if (w !== this.canvas.width || h !== this.canvas.height) {
			this.canvas.width = w;
			this.canvas.height = h;
			this.redraw();
		}
	}

	/** A pointer's place on the card, in the card's own units. */
	private at(e: PointerEvent): [number, number, number] {
		const box = this.card.getBoundingClientRect();
		const x = ((e.clientX - box.left) / box.width) * this.card.offsetWidth;
		const y = ((e.clientY - box.top) / box.height) * this.card.offsetHeight;
		const pressure = e.pointerType === "pen" && e.pressure > 0 ? e.pressure : 0.5;
		return [x, y, pressure];
	}

	private down(e: PointerEvent): void {
		if (e.button !== 0) return;
		e.preventDefault();
		e.stopPropagation();
		this.canvas.setPointerCapture(e.pointerId);
		const colour = this.tool === "red" ? "#B3402F" : this.tool === "mark" ? "#D4AF37" : this.opts.accent;
		this.live = {
			color: colour,
			width: WIDTH[this.tool],
			alpha: this.tool === "mark" ? 0.35 : 1,
			erase: this.tool === "erase",
			points: [this.at(e)],
		};
		this.strokes.push(this.live);
		this.redraw();
	}

	private move(e: PointerEvent): void {
		if (!this.live) return;
		e.preventDefault();
		this.live.points.push(this.at(e));
		this.redraw();
	}

	private up(e: PointerEvent): void {
		if (!this.live) return;
		e.stopPropagation();
		this.live = null;
	}

	private redraw(): void {
		const ctx = this.canvas.getContext("2d");
		if (!ctx) return;
		const sx = this.canvas.width / Math.max(1, this.card.offsetWidth);
		const sy = this.canvas.height / Math.max(1, this.card.offsetHeight);
		ctx.setTransform(1, 0, 0, 1, 0, 0);
		ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
		ctx.setTransform(sx, 0, 0, sy, 0, 0);
		ctx.lineCap = "round";
		ctx.lineJoin = "round";
		for (const s of this.strokes) {
			ctx.globalCompositeOperation = s.erase ? "destination-out" : "source-over";
			ctx.globalAlpha = s.alpha;
			ctx.strokeStyle = s.color;
			const [first, ...rest] = s.points;
			if (!first) continue;
			ctx.lineWidth = s.width * (0.5 + first[2]);
			ctx.beginPath();
			ctx.moveTo(first[0], first[1]);
			if (rest.length === 0) ctx.lineTo(first[0] + 0.1, first[1]);
			for (const p of rest) ctx.lineTo(p[0], p[1]);
			ctx.stroke();
		}
		ctx.globalCompositeOperation = "source-over";
		ctx.globalAlpha = 1;
	}
}
