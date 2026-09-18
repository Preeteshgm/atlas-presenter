/**
 * Is this an element?
 *
 * `node instanceof HTMLElement` asks whether it was made by *this* window's
 * HTMLElement, and a deck presented in a window of its own is full of elements
 * that were not. Every such test silently answers no there: clicks stopped
 * finding the card they were on, and a card laid out in columns quietly kept
 * none of them. The failures look unrelated and are the same line.
 *
 * `nodeType === 1` is the same question asked of the node rather than of the
 * window it came from, so it is true in either.
 */
export function isElement(node: unknown): node is HTMLElement {
	return !!node && typeof node === "object" && (node as Node).nodeType === 1;
}

/**
 * Put a new line in, ourselves.
 *
 * A browser inserts one for plain Enter and for nothing else — Ctrl+Enter and
 * Alt+Enter do nothing at all in a textarea, and Shift+Enter is swallowed here
 * by something outside this plugin. So the box claims Enter for saving, and
 * every other Enter writes the line break itself: at the caret, caret moved
 * after it, and an input event so anything listening for edits sees it the same
 * as a typed character.
 */
export function newlineAt(box: HTMLTextAreaElement): void {
	const start = box.selectionStart ?? box.value.length;
	const end = box.selectionEnd ?? start;
	box.value = `${box.value.slice(0, start)}\n${box.value.slice(end)}`;
	box.setSelectionRange(start + 1, start + 1);
	box.dispatchEvent(new Event("input", { bubbles: true }));
}
