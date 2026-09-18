/**
 * Formatting that more than one part of the plugin needs.
 *
 * Each of these had grown two or three copies — the elapsed clock in the
 * presenter window and on the deck's own HUD, the wall clock in four places,
 * the filename scrub in both things that write a file. Copies of a format are
 * how two views of the same talk end up disagreeing about the time.
 */

/** Elapsed time as `mm:ss`, counting past an hour rather than wrapping. */
export function mmss(ms: number): string {
	const secs = Math.max(0, Math.floor(ms / 1000));
	const mins = Math.floor(secs / 60);
	return `${String(mins).padStart(2, "0")}:${String(secs % 60).padStart(2, "0")}`;
}

/** The wall clock, as the reader's locale writes it. */
export function hhmm(at: number | Date = Date.now()): string {
	return new Date(at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}


/**
 * A name safe to write to disk, on the strictest of the platforms we run on.
 *
 * Windows is that platform, so its reserved set is the one to use everywhere —
 * a vault synced between machines should not produce a file that only opens on
 * one of them.
 */
export function safeFileName(name: string): string {
	return name.replace(/[\\/:*?"<>|]/g, "-").trim() || "Untitled";
}
