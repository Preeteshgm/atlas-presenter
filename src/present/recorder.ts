/**
 * Recording a talk, locally.
 *
 * `MediaRecorder` is built into the browser Obsidian runs on, so nothing here
 * needs a plugin, a key or a network. That is the whole point: a meeting
 * recording is the most sensitive thing a deck will ever produce, and the
 * default has to be that it never leaves the machine.
 *
 * Transcription is the one thing this cannot do alone, so it does not try. If
 * a local speech server is configured it is offered the audio; if not, you get
 * the recording and the timeline, which is most of the value anyway.
 */

/** Ordered by preference; the first the runtime admits to is used. */
const TYPES = [
	"audio/webm;codecs=opus",
	"audio/webm",
	"audio/ogg;codecs=opus",
	"audio/mp4",
];

export interface Clip {
	data: ArrayBuffer;
	/** File extension, without the dot, matching what was actually recorded. */
	ext: string;
	/** How long it ran, in milliseconds. */
	ms: number;
}

function extFor(mime: string): string {
	if (mime.includes("ogg")) return "ogg";
	if (mime.includes("mp4")) return "m4a";
	return "webm";
}

export class Recorder {
	private media: MediaRecorder | null = null;
	private stream: MediaStream | null = null;
	private chunks: Blob[] = [];
	private ctx: AudioContext | null = null;
	private meter: AnalyserNode | null = null;
	private bins: Uint8Array<ArrayBuffer> | null = null;
	private began = 0;

	private flushTimer = 0;

	/**
	 * @param onFlush Handed everything captured so far, periodically, so a long
	 *   recording can be kept on disk while it is still running. Each call gets
	 *   a complete, playable file rather than a fragment — a crash then costs
	 *   the gap since the last one, not the meeting.
	 */
	constructor(
		private win: Window,
		private onFlush?: (data: ArrayBuffer, ext: string) => void,
		private flushEvery = 120_000
	) {}

	get isRecording(): boolean {
		return this.media?.state === "recording";
	}

	/** Milliseconds since this recording started. */
	get elapsed(): number {
		return this.began ? Date.now() - this.began : 0;
	}

	/**
	 * How loud it is right now, 0 to 1.
	 *
	 * Worth the extra twenty lines: a recorder that silently captured nothing —
	 * wrong input device, muted mic — is only discovered after the meeting, when
	 * the thing it was recording cannot be repeated.
	 */
	level(): number {
		if (!this.meter || !this.bins) return 0;
		this.meter.getByteTimeDomainData(this.bins);
		let peak = 0;
		for (const v of this.bins) peak = Math.max(peak, Math.abs(v - 128));
		return Math.min(1, peak / 96);
	}

	async start(): Promise<boolean> {
		if (this.isRecording) return true;
		const devices = this.win.navigator?.mediaDevices;
		if (!devices?.getUserMedia) return false;

		try {
			this.stream = await devices.getUserMedia({
				audio: { echoCancellation: true, noiseSuppression: true },
			});
		} catch {
			// Denied, or there is no microphone. Either way the caller says so.
			return false;
		}

		const mime = TYPES.find((t) => MediaRecorder.isTypeSupported(t)) ?? "";
		try {
			this.media = new MediaRecorder(this.stream, mime ? { mimeType: mime } : undefined);
		} catch {
			this.release();
			return false;
		}

		this.chunks = [];
		this.media.addEventListener("dataavailable", (e) => {
			if (e.data.size > 0) this.chunks.push(e.data);
		});
		// A timeslice, so a crash leaves most of the meeting on the clock rather
		// than one buffer that was never flushed.
		this.media.start(2000);
		this.began = Date.now();

		if (this.onFlush) {
			this.flushTimer = this.win.setInterval(() => {
				if (this.chunks.length === 0) return;
				const blob = new Blob(this.chunks, { type: this.media?.mimeType || "audio/webm" });
				void blob
					.arrayBuffer()
					.then((data) => this.onFlush?.(data, extFor(blob.type)))
					.catch(() => undefined);
			}, this.flushEvery);
		}

		try {
			// The deck can be in a popped-out window, so the constructor has to
			// come from that window rather than from this one.
			const Ctx = (this.win as unknown as { AudioContext: typeof AudioContext }).AudioContext;
			const ctx = new Ctx();
			this.ctx = ctx;
			const source = ctx.createMediaStreamSource(this.stream);
			const meter = ctx.createAnalyser();
			meter.fftSize = 512;
			this.meter = meter;
			// Allocated over an explicit ArrayBuffer: the analyser will only
			// write into one it knows is not shared.
			this.bins = new Uint8Array(new ArrayBuffer(meter.fftSize));
			source.connect(meter);
		} catch {
			// No meter is survivable; no recording is not.
			this.meter = null;
		}

		return true;
	}

	/** Stop, and hand back what was captured. */
	async stop(): Promise<Clip | null> {
		const media = this.media;
		if (!media || media.state === "inactive") {
			this.release();
			return null;
		}

		const ms = this.elapsed;
		const mime = media.mimeType || "audio/webm";
		const done = new Promise<void>((resolve) => {
			media.addEventListener("stop", () => resolve(), { once: true });
		});
		media.stop();
		await done;

		const blob = new Blob(this.chunks, { type: mime });
		this.release();
		if (blob.size === 0) return null;
		return { data: await blob.arrayBuffer(), ext: extFor(mime), ms };
	}

	/** Drop the microphone. Holding it keeps the recording light on. */
	private release(): void {
		if (this.flushTimer) this.win.clearInterval(this.flushTimer);
		this.flushTimer = 0;
		this.stream?.getTracks().forEach((t) => t.stop());
		void this.ctx?.close().catch(() => undefined);
		this.stream = null;
		this.ctx = null;
		this.meter = null;
		this.bins = null;
		this.media = null;
		this.chunks = [];
		this.began = 0;
	}

	/** Called when the deck ends, so a forgotten recording cannot outlive it. */
	dispose(): void {
		try {
			if (this.media?.state === "recording") this.media.stop();
		} catch {
			// Already gone.
		}
		this.release();
	}
}

/**
 * Ask a local speech server what was said.
 *
 * `url` is whatever the user is running on their own machine — whisper.cpp's
 * server, faster-whisper, whisper-asr-webservice. They all take a multipart
 * POST with a file and answer with either JSON carrying `text` or the text
 * itself, which is the shape this handles.
 *
 * Empty url means the feature is off, which is the default and stays the
 * default: audio is the most sensitive thing a deck produces, and sending it
 * anywhere has to be a decision somebody made on purpose.
 */
export async function transcribe(
	url: string,
	clip: Clip,
	fileName: string
): Promise<string | null> {
	if (!url) return null;
	try {
		const form = new FormData();
		form.append("audio_file", new Blob([clip.data]), fileName);
		// The same part under the other common name, so one setting covers the
		// servers that ask for `file` as well as the ones that ask for
		// `audio_file`. A server ignores the part it does not know.
		form.append("file", new Blob([clip.data]), fileName);

		const response = await fetch(url, { method: "POST", body: form });
		if (!response.ok) return null;
		const raw = (await response.text()).trim();
		if (!raw) return null;
		try {
			const parsed: unknown = JSON.parse(raw);
			if (parsed && typeof parsed === "object" && "text" in parsed) {
				const text = (parsed as { text?: unknown }).text;
				return typeof text === "string" ? text.trim() : null;
			}
		} catch {
			// Not JSON, so it is the transcript.
		}
		return raw;
	} catch {
		return null;
	}
}
