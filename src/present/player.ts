/**
 * A sound player in the deck's own colours.
 *
 * The browser's player is a black pill that no theme reaches — on a dark deck
 * it was a hole in the page, on a light one a dark slab. This one is three
 * plain elements styled by the theme's tokens (`.atl-player` in styles.css):
 * play or pause, a line to click along, and the time.
 *
 * Self-contained on purpose: the exported deck carries it as source, through
 * `toString()`, the same way it carries the drawing board — so it may use
 * nothing from outside its own body.
 */
export function themedPlayers(root: ParentNode): void {
	const PLAY = '<svg viewBox="0 0 24 24" width="14" height="14" fill="currentColor"><path d="M7 4.5v15l13-7.5z"/></svg>';
	const PAUSE = '<svg viewBox="0 0 24 24" width="14" height="14" fill="currentColor"><path d="M6 4h4v16H6zM14 4h4v16h-4z"/></svg>';
	const clock = (s: number) => {
		if (!isFinite(s) || s < 0) return "–:––";
		const m = Math.floor(s / 60);
		const r = Math.floor(s % 60);
		return m + ":" + (r < 10 ? "0" : "") + r;
	};
	const audios = Array.prototype.slice.call(root.querySelectorAll("audio")) as HTMLAudioElement[];
	for (const audio of audios) {
		if (audio.dataset.themed === "1") continue;
		audio.dataset.themed = "1";
		audio.controls = false;
		audio.style.display = "none";

		const doc = audio.ownerDocument;
		const bar = doc.createElement("div");
		bar.className = "atl-player";
		const btn = doc.createElement("button");
		btn.type = "button";
		btn.className = "atl-player-btn";
		btn.setAttribute("aria-label", "Play");
		btn.innerHTML = PLAY;
		const track = doc.createElement("div");
		track.className = "atl-player-track";
		const fill = doc.createElement("div");
		fill.className = "atl-player-fill";
		track.appendChild(fill);
		const time = doc.createElement("span");
		time.className = "atl-player-time";
		time.textContent = "0:00";
		bar.appendChild(btn);
		bar.appendChild(track);
		bar.appendChild(time);
		audio.parentNode?.insertBefore(bar, audio.nextSibling);

		// A recording made in the browser often says its length is infinite
		// until it has been read to the end. Asking for a time far past the
		// end makes it work the length out, and then it is put back.
		let length = audio.duration;
		const learn = () => {
			if (isFinite(audio.duration) && audio.duration > 0) {
				length = audio.duration;
				paint();
				return;
			}
			const settle = () => {
				audio.removeEventListener("timeupdate", settle);
				length = audio.duration;
				audio.currentTime = 0;
				paint();
			};
			audio.addEventListener("timeupdate", settle);
			try {
				audio.currentTime = 1e101;
			} catch {
				// Left as unknown; the clock shows elapsed time alone.
			}
		};
		const paint = () => {
			const known = isFinite(length) && length > 0;
			fill.style.width = known ? Math.min(100, (audio.currentTime / length) * 100) + "%" : "0%";
			time.textContent = known ? clock(audio.currentTime) + " / " + clock(length) : clock(audio.currentTime);
		};
		const state = () => {
			const on = !audio.paused;
			btn.innerHTML = on ? PAUSE : PLAY;
			btn.setAttribute("aria-label", on ? "Pause" : "Play");
			bar.classList.toggle("is-playing", on);
		};

		audio.addEventListener("loadedmetadata", learn);
		audio.addEventListener("timeupdate", paint);
		audio.addEventListener("play", state);
		audio.addEventListener("pause", state);
		audio.addEventListener("ended", () => {
			state();
			paint();
		});
		audio.addEventListener("error", () => {
			bar.classList.add("is-missing");
			time.textContent = "not found";
		});
		btn.addEventListener("click", (e) => {
			e.stopPropagation();
			if (audio.paused) void audio.play().catch(() => bar.classList.add("is-missing"));
			else audio.pause();
		});
		track.addEventListener("click", (e) => {
			e.stopPropagation();
			if (!isFinite(length) || length <= 0) return;
			const box = track.getBoundingClientRect();
			audio.currentTime = Math.max(0, Math.min(1, (e.clientX - box.left) / box.width)) * length;
			paint();
		});
		if (audio.readyState >= 1) learn();
	}
}
