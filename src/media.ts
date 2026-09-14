/**
 * Which file extensions Atlas treats as what.
 *
 * There were three lists: one for rendering a card, one for the logo and
 * backdrop pickers, and one mapping extensions to MIME types for the export.
 * They disagreed — a `.bmp` rendered on a card but could not be chosen as a
 * logo, and several formats that rendered were exported as
 * `application/octet-stream`, which no browser will display. One table means a
 * format is either supported everywhere or nowhere.
 */

const IMAGE: Record<string, string> = {
	png: "image/png",
	jpg: "image/jpeg",
	jpeg: "image/jpeg",
	gif: "image/gif",
	svg: "image/svg+xml",
	webp: "image/webp",
	avif: "image/avif",
	bmp: "image/bmp",
};

const VIDEO: Record<string, string> = {
	mp4: "video/mp4",
	webm: "video/webm",
	ogv: "video/ogg",
	mov: "video/quicktime",
	m4v: "video/mp4",
	mkv: "video/x-matroska",
};

const AUDIO: Record<string, string> = {
	mp3: "audio/mpeg",
	wav: "audio/wav",
	m4a: "audio/mp4",
	ogg: "audio/ogg",
	flac: "audio/flac",
	aac: "audio/aac",
};

const MIME: Record<string, string> = { ...IMAGE, ...VIDEO, ...AUDIO };

/** `\.(png|jpe?g|…)$` built from the table, so the two cannot drift apart. */
function matcher(table: Record<string, string>): RegExp {
	return new RegExp(`\\.(${Object.keys(table).join("|")})$`, "i");
}

export const IMAGE_EXT = matcher(IMAGE);
export const VIDEO_EXT = matcher(VIDEO);
export const AUDIO_EXT = matcher(AUDIO);

export function mimeFor(extension: string): string {
	return MIME[extension.toLowerCase()] ?? "application/octet-stream";
}
