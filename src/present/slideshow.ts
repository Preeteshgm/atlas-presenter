import { SlideshowTransition } from "../types";

/**
 * An album inside one card.
 *
 * Piggybacking this on the reveal system only ever gave a crossfade, because
 * reveals stack up and never come back. A slide show has a *current* frame
 * instead, which is what makes a carousel, a swipe, and a set of dots possible.
 */
export class Slideshow {
	private frames: HTMLElement[];
	private dots: HTMLElement[] = [];
	private index = 0;
	private start: { x: number; y: number } | null = null;

	constructor(
		private root: HTMLElement,
		private mode: SlideshowTransition,
		private fit: "contain" | "cover"
	) {
		// A frame must be a *container*. When the markdown puts <img> straight
		// inside the container, the image would otherwise become the frame
		// itself — absolutely positioned, with object-fit unable to apply to it,
		// so it filled the width and lost its bottom half.
		this.frames = (Array.from(root.children) as HTMLElement[]).map((child) => {
			if (child.tagName !== "IMG" && child.tagName !== "VIDEO") return child;
			const wrapper = createDiv();
			child.replaceWith(wrapper);
			wrapper.appendChild(child);
			return wrapper;
		});
		for (const frame of this.frames) frame.classList.add("atl-frame-item");

		root.classList.add("atl-show", `tx-${mode}`);
		root.style.setProperty("--atl-show-fit", this.fit);

		if (this.frames.length > 1) {
			this.buildControls();
			this.bindSwipe();
		}
		this.layout(false);
	}

	/**
	 * One control row rather than arrows pinned to the stage edges.
	 *
	 * A picture that does not fill the stage — a portrait photo in a wide card —
	 * leaves the edges far from the image, so edge-anchored arrows float in
	 * empty space. Keeping them beside the dots puts every control next to the
	 * thing it controls, whatever shape the picture is.
	 */
	private buildControls(): void {
		const bar = this.root.createDiv({ cls: "atl-show-controls" });

		const prev = bar.createEl("button", { cls: "atl-show-arrow", text: "‹" });
		prev.setAttribute("aria-label", "Previous image");
		prev.addEventListener("click", (e) => {
			e.stopPropagation();
			this.prev();
		});

		const strip = bar.createDiv({ cls: "atl-show-dots" });
		this.frames.forEach((_, i) => {
			const dot = strip.createEl("button", { cls: "atl-show-dot" });
			dot.setAttribute("aria-label", `Image ${i + 1}`);
			dot.addEventListener("click", (e) => {
				e.stopPropagation();
				this.goTo(i);
			});
			this.dots.push(dot);
		});

		const next = bar.createEl("button", { cls: "atl-show-arrow", text: "›" });
		next.setAttribute("aria-label", "Next image");
		next.addEventListener("click", (e) => {
			e.stopPropagation();
			this.next();
		});
	}

	/** Swipe in any direction; sideways and upward both mean "onwards". */
	private bindSwipe(): void {
		this.root.addEventListener("pointerdown", (e) => {
			this.start = { x: e.clientX, y: e.clientY };
		});
		this.root.addEventListener("pointerup", (e) => {
			if (!this.start) return;
			const dx = e.clientX - this.start.x;
			const dy = e.clientY - this.start.y;
			this.start = null;
			const horizontal = Math.abs(dx) > Math.abs(dy);
			const travel = horizontal ? dx : dy;
			if (Math.abs(travel) < 45) return;
			e.stopPropagation();
			if (travel < 0) this.next();
			else this.prev();
		});
		this.root.addEventListener("pointercancel", () => {
			this.start = null;
		});
	}

	private layout(animate = true): void {
		for (const [i, frame] of this.frames.entries()) {
			const d = i - this.index;
			frame.classList.toggle("is-current", d === 0);
			frame.setCssStyles({ transition: animate ? "" : "none" });

			// Where each frame sits is arithmetic on its distance from the current
			// one, so it cannot be a class: setCssStyles is how Obsidian asks for
			// a computed style to be written.
			switch (this.mode) {
				case "slide":
					// A true carousel: every frame keeps its place on a strip and
					// the strip moves, so direction comes out for free.
					frame.setCssStyles({ transform: `translateX(${d * 100}%)`, opacity: "1" });
					break;
				case "slide-up":
					frame.setCssStyles({ transform: `translateY(${d * 100}%)`, opacity: "1" });
					break;
				case "zoom":
					frame.setCssStyles({
						transform: d === 0 ? "scale(1)" : "scale(1.06)",
						opacity: d === 0 ? "1" : "0",
					});
					break;
				case "flip":
					frame.setCssStyles({
						transform: `perspective(1400px) rotateY(${d * 78}deg)`,
						opacity: Math.abs(d) <= 1 ? (d === 0 ? "1" : "0") : "0",
					});
					break;
				default:
					frame.setCssStyles({ transform: "none", opacity: d === 0 ? "1" : "0" });
			}
		}
		this.dots.forEach((dot, i) => dot.toggleClass("is-current", i === this.index));

		if (!animate) {
			// Force the frame to settle before transitions are allowed back.
			void this.root.offsetHeight;
			for (const frame of this.frames) frame.setCssStyles({ transition: "" });
		}
	}

	private goTo(i: number): void {
		this.index = Math.max(0, Math.min(i, this.frames.length - 1));
		this.layout();
	}

	/** Returns false when there is nothing further, so the deck can move on. */
	next(): boolean {
		if (this.index >= this.frames.length - 1) return false;
		this.goTo(this.index + 1);
		return true;
	}

	prev(): boolean {
		if (this.index <= 0) return false;
		this.goTo(this.index - 1);
		return true;
	}

	/** Arriving forwards starts at the first frame, backwards at the last. */
	reset(atEnd: boolean): void {
		this.index = atEnd ? this.frames.length - 1 : 0;
		this.layout(false);
	}
}
