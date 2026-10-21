/**
 * A deck to PDF, inside Obsidian.
 *
 * The exported HTML already carries the deck as pages — one card to a sheet,
 * shown only to a printer. A browser prints them; Obsidian has nowhere to
 * print from, and a print dialog raised in the deck's own window would open
 * over a live talk. So the same document is loaded into a window nobody sees
 * and Chromium writes it straight to a PDF: no dialog, nothing on the screen,
 * and the pages are exactly the ones a browser would print.
 *
 * Desktop only. On mobile there is no second window to make, and the export
 * printed from a browser is the way there.
 */

interface PdfWindow {
	loadFile(path: string): Promise<void>;
	webContents: {
		printToPDF(options: Record<string, unknown>): Promise<Uint8Array>;
	};
	destroy(): void;
}
interface Remote {
	BrowserWindow: new (options: Record<string, unknown>) => PdfWindow;
}

/** Node's modules and Electron's remote, where Obsidian gives them. */
function desktop(): {
	remote: Remote;
	fs: { writeFileSync(p: string, d: string, e: string): void; unlinkSync(p: string): void };
	os: { tmpdir(): string };
	path: { join(...p: string[]): string };
} | null {
	const req = (window as unknown as { require?: (m: string) => unknown }).require;
	if (!req) return null;
	try {
		let remote: Remote | undefined;
		try {
			remote = req("@electron/remote") as Remote;
		} catch {
			remote = (req("electron") as { remote?: Remote }).remote;
		}
		if (!remote) return null;
		return {
			remote,
			fs: req("fs") as never,
			os: req("os") as never,
			path: req("path") as never,
		};
	} catch {
		return null;
	}
}

/** Whether this Obsidian can write a PDF at all. */
export function canPrintPdf(): boolean {
	return desktop() !== null;
}

/**
 * The exported document, printed to PDF bytes.
 *
 * Through a file rather than a data URL: an export with its pictures inside
 * runs to tens of megabytes, and Chromium refuses a URL that long.
 */
export async function printHtmlToPdf(html: string): Promise<ArrayBuffer> {
	const d = desktop();
	if (!d) throw new Error("saving a PDF needs the desktop app");
	const file = d.path.join(d.os.tmpdir(), `atlas-print-${Date.now()}.html`);
	d.fs.writeFileSync(file, html, "utf8");
	const win = new d.remote.BrowserWindow({
		show: false,
		width: 1400,
		height: 900,
		webPreferences: { javascript: true, nodeIntegration: false, contextIsolation: true },
	});
	try {
		await win.loadFile(file);
		// Loaded is not drawn: fonts and the pictures inside the cards decode
		// after the load event, and a page printed before they do has holes.
		await new Promise((r) => window.setTimeout(r, 900));
		const bytes = await win.webContents.printToPDF({
			printBackground: true,
			preferCSSPageSize: true,
			landscape: true,
		});
		return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
	} finally {
		win.destroy();
		try {
			d.fs.unlinkSync(file);
		} catch {
			// The temporary folder is the system's to tidy.
		}
	}
}
