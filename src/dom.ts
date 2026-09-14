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
