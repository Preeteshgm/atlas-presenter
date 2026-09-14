import { Rect } from "../types";
import { rectOf } from "../canvas/parse";

export interface CameraPose {
	cx: number;
	cy: number;
	scale: number;
}

/**
 * The whole deck lives on one absolutely-positioned plane in canvas
 * coordinates. Presenting is just moving a camera over that plane, so every
 * transition is a pan + zoom rather than a cut. This is the difference between
 * a deck and a map you walk across.
 */
export class Camera {
	private pose: CameraPose = { cx: 0, cy: 0, scale: 1 };
	private anim: Animation | null = null;

	constructor(
		private stage: HTMLElement,
		private viewport: HTMLElement,
		private opts: {
			padding: number;
			maxScale: number;
			fit: "contain" | "cover";
			align: "centre" | "top";
		}
	) {}

	/**
	 * The pose that frames `target`.
	 *
	 * "contain" takes the smaller ratio, so the whole card is visible and any
	 * difference between the card's shape and the screen's becomes margin.
	 * "cover" takes the larger, filling the screen and cropping the overflow —
	 * only sensible when the two shapes are already close.
	 */
	poseFor(target: Rect): CameraPose {
		const r = rectOf(target);
		const vw = this.viewport.clientWidth || 1;
		const vh = this.viewport.clientHeight || 1;
		const pad = 1 + this.opts.padding * 2;
		const byWidth = vw / (r.width * pad || 1);
		const byHeight = vh / (r.height * pad || 1);
		const wanted =
			this.opts.fit === "cover" ? Math.max(byWidth, byHeight) : Math.min(byWidth, byHeight);
		const scale = Math.min(wanted, this.opts.maxScale);

		// Centring splits any leftover height between top and bottom. Aligning
		// to the top gathers it all underneath, where a header or notes can use
		// it instead of it being two thin unusable bands.
		const visible = vh / scale;
		const cy =
			this.opts.align === "top" && visible > r.height
				? r.y - r.height * this.opts.padding + visible / 2
				: r.y + r.height / 2;

		return { cx: r.x + r.width / 2, cy, scale };
	}

	private transform(p: CameraPose): string {
		const vw = this.viewport.clientWidth / 2;
		const vh = this.viewport.clientHeight / 2;
		return `translate(${vw}px, ${vh}px) scale(${p.scale}) translate(${-p.cx}px, ${-p.cy}px)`;
	}

	/**
	 * Move to a pose that has already been decided.
	 *
	 * `flyTo` works out its own zoom from what it is framing, which is right for
	 * presenting and wrong for browsing: scrolling around the deck at a readable
	 * size means the scale is chosen once and then held while only the position
	 * changes. No zoom-out arc either — that reads as travel, and this is not
	 * travel, it is scrolling.
	 */
	moveTo(pose: CameraPose, duration: number): Promise<void> {
		const fromT = this.transform(this.pose);
		const toT = this.transform(pose);
		this.pose = pose;
		this.stage.style.transform = toT;

		this.anim?.cancel();
		if (duration <= 0 || fromT === toT) return Promise.resolve();
		this.anim = this.stage.animate([{ transform: fromT }, { transform: toT }], {
			duration,
			easing: "cubic-bezier(0.33, 0, 0.2, 1)",
			fill: "both",
		});
		return this.anim.finished.then(
			() => undefined,
			() => undefined
		);
	}

	/** The pose in force, so a browsing mode can pan from where it is. */
	get current(): CameraPose {
		return { ...this.pose };
	}

	snapTo(target: Rect): void {
		this.anim?.cancel();
		this.anim = null;
		this.pose = this.poseFor(target);
		this.stage.style.transform = this.transform(this.pose);
	}

	flyTo(target: Rect, duration: number): Promise<void> {
		const to = this.poseFor(target);
		const from = this.pose;
		this.pose = to;

		const fromT = this.transform(from);
		const toT = this.transform(to);
		this.stage.style.transform = toT;

		this.anim?.cancel();
		if (duration <= 0 || fromT === toT) return Promise.resolve();

		// A zoom-out-then-in arc reads as travel across a map; a straight
		// interpolation reads as a smear when the two cards are far apart.
		const dist = Math.hypot(to.cx - from.cx, to.cy - from.cy);
		const span = Math.max(this.viewport.clientWidth, 1) / Math.max(from.scale, 0.0001);
		const dip = dist > span * 0.9 ? 0.72 : 1;
		const mid: CameraPose = {
			cx: (from.cx + to.cx) / 2,
			cy: (from.cy + to.cy) / 2,
			scale: Math.min(from.scale, to.scale) * dip,
		};

		this.anim = this.stage.animate(
			[
				{ transform: fromT },
				{ transform: this.transform(mid), offset: 0.5 },
				{ transform: toT },
			],
			{ duration, easing: "cubic-bezier(0.6, 0, 0.2, 1)", fill: "both" }
		);
		return this.anim.finished.then(
			() => undefined,
			() => undefined // cancelled by a faster click; not an error
		);
	}
}
