import { Notice } from "obsidian";

/**
 * Everything Atlas says out loud.
 *
 * The `Atlas: ` prefix was retyped at twenty-odd call sites and forgotten at
 * one, so a single message appeared to come from Obsidian itself. Saying it in
 * one place is the only way that stays true.
 */

const PREFIX = "Atlas: ";

export function say(message: string, ms = 4000): Notice {
	return new Notice(PREFIX + message, ms);
}

/**
 * A failure, said plainly.
 *
 * `what` names the thing that did not happen, in the user's terms rather than
 * the code's — "could not write the minutes", not "writeMinutes threw".
 */
export function fail(what: string, e?: unknown): Notice {
	const detail = e === undefined ? "" : ` — ${e instanceof Error ? e.message : String(e)}`;
	return new Notice(`${PREFIX}${what}${detail}`, 8000);
}

/**
 * A notice you can act on.
 *
 * Some messages name a thing the user now has to go and find — an exported
 * file, a note just written. A line of text leaves them looking; a button
 * does not.
 */
export function offer(build: (el: HTMLElement, close: () => void) => void, ms = 12000): void {
	const notice = new Notice("", ms);
	const el = notice.noticeEl;
	el.empty();
	el.addClass("atl-notice");
	build(el, () => notice.hide());
}
