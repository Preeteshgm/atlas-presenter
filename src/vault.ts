import { App, TFile, TFolder, normalizePath } from "obsidian";

/**
 * Looking things up in the vault by path.
 *
 * `getAbstractFileByPath` returns a file, a folder or nothing, so every caller
 * has to normalise the path and then narrow the result — which had grown six
 * near-identical copies, not all of them normalising. A path that works in one
 * place and not another is a bad way to find that out.
 */

export function fileAt(app: App, path: string): TFile | null {
	if (!path) return null;
	const found = app.vault.getAbstractFileByPath(normalizePath(path));
	return found instanceof TFile ? found : null;
}

export function folderAt(app: App, path: string): TFolder | null {
	if (!path) return null;
	const found = app.vault.getAbstractFileByPath(normalizePath(path));
	return found instanceof TFolder ? found : null;
}

/** The contents of a file, or null if it is not there or will not be read. */
export async function readFileAt(app: App, path: string): Promise<string | null> {
	const file = fileAt(app, path);
	if (!file) return null;
	try {
		return await app.vault.cachedRead(file);
	} catch {
		return null;
	}
}
