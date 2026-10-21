/**
 * Drawing on a frozen card (D).
 *
 * A canvas laid over the card itself, so the ink stays where it was put if the
 * window resizes or the camera moves. Everything drawn is kept as items in the
 * card's own units — a stroke, an arrow, a box, an ellipse, a line of text —
 * and redrawn at whatever size the card is shown, so it stays sharp and undo
 * is "drop the last item and redraw".
 *
 * The deck owns what happens when drawing ends — saved into the card's note in
 * Obsidian, simply let go in an exported file — so this class only draws.
 *
 * The exported deck runs this very class: its source is written into the file.
 * So it must stand alone — no imports, no module-level helpers, nothing set up
 * outside the constructor — or the copy in the file would reach for something
 * that is not there.
 */

type Tool = "pen" | "mark" | "arrow" | "rect" | "ellipse" | "text" | "erase";
type Pt = [number, number, number];
interface Item {
	tool: Tool;
	color: string;
	size: number;
	points: Pt[];
	text?: string;
}

export interface InkOptions {
	/** The deck's accent: the blue swatch. */
	accent: string;
	/** True in Obsidian, where finishing saves; false shows only Done. */
	saves: boolean;
	/** Called when the person finishes: keep the ink, or throw it away. */
	onDone: (keep: boolean) => void;
}

export class Ink {
	readonly canvas: HTMLCanvasElement;
	private bar: HTMLElement;
	private items: Item[];
	private undone: Item[];
	private live: Item | null;
	private tool: Tool;
	private color: string;
	private size: number;
	private shift: boolean;
	private ro: ResizeObserver | null;
	private typing: HTMLInputElement | null;
	private colours: string[];
	private swatches: HTMLElement;

	constructor(
		readonly card: HTMLElement,
		host: HTMLElement,
		private readonly opts: InkOptions
	) {
		this.items = [];
		this.undone = [];
		this.live = null;
		this.tool = "pen";
		this.color = "#B3402F";
		this.size = 2;
		this.shift = false;
		this.ro = null;
		this.typing = null;
		this.colours = ["#B3402F", opts.accent || "#1D5A78", "#4E8A3C", "#D4AF37", "#14232A", "#FFFFFF"];

		const doc = card.ownerDocument;
		this.canvas = doc.createElement("canvas");
		this.canvas.className = "atl-ink";
		card.appendChild(this.canvas);

		this.bar = doc.createElement("div");
		this.bar.className = "atl-ink-bar";
		this.swatches = doc.createElement("span");
		this.build();
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
		return this.items.some((i) => i.tool !== "erase");
	}

	undo(): void {
		const it = this.items.pop();
		if (it) this.undone.push(it);
		this.redraw();
	}

	redo(): void {
		const it = this.undone.pop();
		if (it) this.items.push(it);
		this.redraw();
	}

	clear(): void {
		this.items = [];
		this.undone = [];
		this.redraw();
	}

	/**
	 * A key while drawing: the Excalidraw letters pick a tool, 1–6 a colour.
	 * Returns true when the key was this board's.
	 */
	key(e: KeyboardEvent): boolean {
		if (this.typing) return false;
		const k = e.key;
		if ((e.ctrlKey || e.metaKey) && (k === "z" || k === "Z")) {
			if (e.shiftKey) this.redo();
			else this.undo();
			return true;
		}
		if ((e.ctrlKey || e.metaKey) && (k === "y" || k === "Y")) {
			this.redo();
			return true;
		}
		if (e.ctrlKey || e.metaKey || e.altKey) return false;
		const tools: Record<string, Tool> = { p: "pen", h: "mark", a: "arrow", r: "rect", o: "ellipse", t: "text", e: "erase" };
		const t = tools[k.toLowerCase()];
		if (t) {
			this.pick(t);
			return true;
		}
		const n = Number(k);
		if (n >= 1 && n <= this.colours.length) {
			this.paint(this.colours[n - 1]);
			return true;
		}
		return false;
	}

	/** The card moved or changed size on screen: redraw the ink to match. */
	refit(): void {
		this.fit();
	}

	/** True when the card comes so close to the left edge that the bar would sit on it. */
	crowds(): boolean {
		const view = this.card.ownerDocument.defaultView;
		const box = this.card.getBoundingClientRect();
		return !!view && view.innerWidth > 760 && box.left < 84;
	}

	/** Hide the toolbar, so a capture of the card shows only the card and its ink. */
	hideBar(): void {
		this.bar.classList.add("is-hidden");
	}

	/** The ink on the card's own background, for when the screen itself cannot be captured. */
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
		this.commitText();
		if (this.ro) this.ro.disconnect();
		this.canvas.remove();
		this.bar.remove();
	}

	// ── the toolbar: icons only, the name on hover ──────────────────────────

	private build(): void {
		const ICON: Record<string, string> = {
			pen: '<path d="M21.2 6.8a1 1 0 0 0-4-4L3.8 16.2a2 2 0 0 0-.5.8L2 21.4a.5.5 0 0 0 .6.6L7 20.7a2 2 0 0 0 .8-.5z"/>',
			mark: '<path d="m9 11-6 6v3h9l3-3"/><path d="m22 12-4.6 4.6a2 2 0 0 1-2.8 0l-5.2-5.2a2 2 0 0 1 0-2.8L14 4"/>',
			arrow: '<path d="M7 7h10v10"/><path d="M7 17 17 7"/>',
			rect: '<rect width="18" height="18" x="3" y="3" rx="2"/>',
			ellipse: '<circle cx="12" cy="12" r="10"/>',
			text: '<path d="M4 7V4h16v3"/><path d="M9 20h6"/><path d="M12 4v16"/>',
			erase: '<path d="m7 21-4.3-4.3c-1-1-1-2.5 0-3.4l9.6-9.6c1-1 2.5-1 3.4 0l5.6 5.6c1 1 1 2.5 0 3.4L13 21"/><path d="M22 21H7"/><path d="m5 11 9 9"/>',
			undo: '<path d="M9 14 4 9l5-5"/><path d="M4 9h10.5a5.5 5.5 0 0 1 0 11H11"/>',
			redo: '<path d="m15 14 5-5-5-5"/><path d="M20 9H9.5a5.5 5.5 0 0 0 0 11H13"/>',
			clear: '<path d="M3 6h18"/><path d="M19 6v14c0 1-1 2-2 2H7c-1 0-2-1-2-2V6"/><path d="M8 6V4c0-1 1-2 2-2h4c1 0 2 1 2 2v2"/>',
			discard: '<path d="M18 6 6 18"/><path d="m6 6 12 12"/>',
			save: '<path d="M20 6 9 17l-5-5"/>',
			plus: '<path d="M5 12h14"/><path d="M12 5v14"/>',
		};
		const doc = this.card.ownerDocument;
		const svg = (name: string) =>
			`<svg viewBox="0 0 24 24" width="17" height="17" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${ICON[name]}</svg>`;
		const btn = (cls: string, title: string, inner: string, act: () => void): HTMLButtonElement => {
			const b = doc.createElement("button");
			b.type = "button";
			b.className = cls;
			b.title = title;
			b.setAttribute("aria-label", title);
			b.innerHTML = inner;
			b.addEventListener("click", (e) => {
				e.stopPropagation();
				act();
			});
			this.bar.appendChild(b);
			return b;
		};
		const gap = () => this.bar.appendChild(doc.createElement("i"));
		const tools: [Tool, string][] = [["pen", "Pen · P"], ["mark", "Highlighter · H"], ["arrow", "Arrow · A"], ["rect", "Rectangle · R"],
			["ellipse", "Ellipse · O"], ["text", "Text · T"], ["erase", "Eraser · E"]];
		for (const [t, title] of tools) {
			const b = btn("atl-ink-btn atl-ink-tool", title, svg(t), () => this.pick(t));
			b.dataset.tool = t;
		}
		gap();
		this.swatches.className = "atl-ink-sw";
		this.bar.appendChild(this.swatches);
		this.drawSwatches();
		const picker = doc.createElement("input");
		picker.type = "color";
		picker.className = "atl-ink-pick";
		picker.value = "#7A4FA3";
		picker.addEventListener("input", () => {
			if (this.colours.length > 6) this.colours[6] = picker.value;
			else this.colours.push(picker.value);
			this.paint(picker.value);
		});
		this.bar.appendChild(picker);
		btn("atl-ink-btn", "Another colour", svg("plus"), () => picker.click());
		gap();
		for (const [s, title] of [[1, "Thin"], [2, "Medium"], [3, "Thick"]] as [number, string][]) {
			const b = btn("atl-ink-btn atl-ink-size", title, `<b style="width:${3 + s * 3}px;height:${3 + s * 3}px"></b>`, () => this.resize(s));
			b.dataset.size = String(s);
		}
		gap();
		btn("atl-ink-btn", "Undo · Ctrl+Z", svg("undo"), () => this.undo());
		btn("atl-ink-btn", "Redo · Ctrl+Shift+Z", svg("redo"), () => this.redo());
		btn("atl-ink-btn", "Clear", svg("clear"), () => this.clear());
		if (this.opts.saves) {
			btn("atl-ink-btn", "Discard", svg("discard"), () => this.opts.onDone(false));
			gap();
			btn("atl-ink-btn is-main", "Save to the card's note · D", svg("save"), () => this.opts.onDone(true));
		} else {
			gap();
			btn("atl-ink-btn is-main", "Done · D", svg("save"), () => this.opts.onDone(false));
		}
		this.mark();
	}

	private drawSwatches(): void {
		const doc = this.card.ownerDocument;
		this.swatches.innerHTML = "";
		const names = ["Red", "Blue", "Green", "Gold", "Black", "White", "Your colour"];
		this.colours.forEach((c, n) => {
			const b = doc.createElement("button");
			b.type = "button";
			b.className = "atl-ink-btn atl-ink-col";
			b.title = `${names[n]} · ${n + 1}`;
			b.setAttribute("aria-label", names[n]);
			b.style.setProperty("--c", c);
			b.dataset.c = c;
			b.addEventListener("click", (e) => {
				e.stopPropagation();
				this.paint(c);
			});
			this.swatches.appendChild(b);
		});
		this.mark();
	}

	private pick(t: Tool): void {
		this.commitText();
		this.tool = t;
		this.canvas.style.cursor = t === "text" ? "text" : "crosshair";
		this.mark();
	}

	private paint(c: string): void {
		this.color = c;
		if (this.colours.indexOf(c) < 0) this.drawSwatches();
		if (this.typing) this.typing.style.color = c;
		this.mark();
	}

	private resize(s: number): void {
		this.size = s;
		this.mark();
	}

	/** Show which tool, colour and size are on. */
	private mark(): void {
		for (const b of Array.from(this.bar.querySelectorAll<HTMLElement>(".atl-ink-tool"))) b.classList.toggle("is-on", b.dataset.tool === this.tool);
		for (const b of Array.from(this.bar.querySelectorAll<HTMLElement>(".atl-ink-col"))) b.classList.toggle("is-on", b.dataset.c === this.color);
		for (const b of Array.from(this.bar.querySelectorAll<HTMLElement>(".atl-ink-size"))) b.classList.toggle("is-on", b.dataset.size === String(this.size));
	}

	// ── drawing ─────────────────────────────────────────────────────────────

	/** Size the canvas to the card as it is shown, so the ink is drawn sharp. */
	private fit(): void {
		const box = this.card.getBoundingClientRect();
		const view = this.card.ownerDocument.defaultView;
		const ratio = (view && view.devicePixelRatio) || 1;
		const w = Math.max(1, Math.round(box.width * ratio));
		const h = Math.max(1, Math.round(box.height * ratio));
		if (w !== this.canvas.width || h !== this.canvas.height) {
			this.canvas.width = w;
			this.canvas.height = h;
			this.redraw();
		}
	}

	/** A pointer's place on the card, in the card's own units, with the pen's pressure. */
	private at(e: PointerEvent): Pt {
		const box = this.card.getBoundingClientRect();
		const x = ((e.clientX - box.left) / box.width) * this.card.offsetWidth;
		const y = ((e.clientY - box.top) / box.height) * this.card.offsetHeight;
		return [x, y, e.pointerType === "pen" && e.pressure > 0 ? e.pressure : 0.5];
	}

	private down(e: PointerEvent): void {
		if (e.button !== 0) return;
		e.preventDefault();
		e.stopPropagation();
		if (this.tool === "text") {
			this.commitText();
			this.startText(this.at(e));
			return;
		}
		this.canvas.setPointerCapture(e.pointerId);
		const p = this.at(e);
		this.live = { tool: this.tool, color: this.color, size: this.size, points: [p, p] };
		this.items.push(this.live);
		this.undone = [];
		this.redraw();
	}

	private move(e: PointerEvent): void {
		if (!this.live) return;
		e.preventDefault();
		this.shift = e.shiftKey;
		const p = this.at(e);
		const freehand = this.live.tool === "pen" || this.live.tool === "mark" || this.live.tool === "erase";
		if (freehand) this.live.points.push(p);
		else this.live.points[1] = p;
		this.redraw();
	}

	private up(e: PointerEvent): void {
		if (!this.live) return;
		e.stopPropagation();
		if (this.shift && this.live.tool !== "pen" && this.live.tool !== "mark" && this.live.tool !== "erase") {
			this.live.points[1] = this.snap(this.live.tool, this.live.points[0], this.live.points[1]);
		}
		this.live = null;
		this.redraw();
	}

	/** Shift: an arrow snaps to 45°, a box to a square, an ellipse to a circle. */
	private snap(tool: Tool, a: Pt, b: Pt): Pt {
		const dx = b[0] - a[0];
		const dy = b[1] - a[1];
		if (tool === "arrow") {
			const len = Math.hypot(dx, dy);
			const ang = Math.round(Math.atan2(dy, dx) / (Math.PI / 4)) * (Math.PI / 4);
			return [a[0] + Math.cos(ang) * len, a[1] + Math.sin(ang) * len, b[2]];
		}
		const side = Math.max(Math.abs(dx), Math.abs(dy));
		return [a[0] + Math.sign(dx || 1) * side, a[1] + Math.sign(dy || 1) * side, b[2]];
	}

	/** Text: a box on the card where you clicked; Enter puts it down, Esc lets it go. */
	private startText(p: Pt): void {
		const doc = this.card.ownerDocument;
		const input = doc.createElement("input");
		input.className = "atl-ink-text";
		input.type = "text";
		const sizePx = [0, 16, 24, 36][this.size];
		input.style.left = `${(p[0] / this.card.offsetWidth) * 100}%`;
		input.style.top = `${(p[1] / this.card.offsetHeight) * 100}%`;
		input.style.color = this.color;
		input.style.fontSize = `${sizePx}px`;
		input.dataset.x = String(p[0]);
		input.dataset.y = String(p[1]);
		input.addEventListener("keydown", (e) => {
			e.stopPropagation();
			if (e.key === "Enter") {
				e.preventDefault();
				this.commitText();
			} else if (e.key === "Escape") {
				e.preventDefault();
				input.value = "";
				this.commitText();
			}
		});
		input.addEventListener("pointerdown", (e) => e.stopPropagation());
		this.card.appendChild(input);
		this.typing = input;
		setTimeout(() => input.focus(), 0);
	}

	private commitText(): void {
		const input = this.typing;
		if (!input) return;
		this.typing = null;
		const text = input.value.trim();
		if (text) {
			const x = Number(input.dataset.x);
			const y = Number(input.dataset.y);
			this.items.push({ tool: "text", color: input.style.color || this.color, size: this.size, points: [[x, y, 0.5]], text });
			this.undone = [];
		}
		input.remove();
		this.redraw();
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
		for (const it of this.items) {
			const w = [0, 2, 4, 8][it.size];
			ctx.globalCompositeOperation = it.tool === "erase" ? "destination-out" : "source-over";
			ctx.globalAlpha = it.tool === "mark" ? 0.35 : 1;
			ctx.strokeStyle = it.color;
			ctx.fillStyle = it.color;
			const [a, b] = it.points;
			if (!a) continue;
			if (it.tool === "text") {
				ctx.font = `600 ${[0, 16, 24, 36][it.size]}px system-ui, sans-serif`;
				ctx.textBaseline = "top";
				ctx.fillText(it.text || "", a[0] + 2, a[1] + 2);
				continue;
			}
			const end = it === this.live && this.shift && (it.tool === "arrow" || it.tool === "rect" || it.tool === "ellipse") ? this.snap(it.tool, a, b) : b;
			ctx.beginPath();
			if (it.tool === "pen" || it.tool === "mark" || it.tool === "erase") {
				ctx.lineWidth = it.tool === "mark" ? w * 4 : it.tool === "erase" ? w * 6 : w * (0.5 + a[2]);
				ctx.moveTo(a[0], a[1]);
				if (it.points.length < 3 && b && b[0] === a[0] && b[1] === a[1]) ctx.lineTo(a[0] + 0.1, a[1]);
				for (const p of it.points.slice(1)) ctx.lineTo(p[0], p[1]);
				ctx.stroke();
			} else if (it.tool === "arrow") {
				ctx.lineWidth = w;
				ctx.moveTo(a[0], a[1]);
				ctx.lineTo(end[0], end[1]);
				const ang = Math.atan2(end[1] - a[1], end[0] - a[0]);
				const head = 8 + w * 2;
				ctx.moveTo(end[0], end[1]);
				ctx.lineTo(end[0] - head * Math.cos(ang - 0.45), end[1] - head * Math.sin(ang - 0.45));
				ctx.moveTo(end[0], end[1]);
				ctx.lineTo(end[0] - head * Math.cos(ang + 0.45), end[1] - head * Math.sin(ang + 0.45));
				ctx.stroke();
			} else if (it.tool === "rect") {
				ctx.lineWidth = w;
				ctx.strokeRect(Math.min(a[0], end[0]), Math.min(a[1], end[1]), Math.abs(end[0] - a[0]), Math.abs(end[1] - a[1]));
			} else if (it.tool === "ellipse") {
				ctx.lineWidth = w;
				ctx.ellipse((a[0] + end[0]) / 2, (a[1] + end[1]) / 2, Math.abs(end[0] - a[0]) / 2, Math.abs(end[1] - a[1]) / 2, 0, 0, Math.PI * 2);
				ctx.stroke();
			}
		}
		ctx.globalCompositeOperation = "source-over";
		ctx.globalAlpha = 1;
	}
}
