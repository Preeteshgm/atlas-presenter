import { App, TFile, TFolder, normalizePath } from "obsidian";

/**
 * Asking your own notes a question.
 *
 * Everything here runs against a model on this machine. Notes are the most
 * private thing in a vault, and a search that quietly posted them somewhere
 * would be a worse feature than no search at all — so the address is checked
 * to be local before anything is sent, and the whole thing is off until
 * somebody turns it on.
 *
 * The shape, in order: the model turns the question into search terms; words
 * find candidates; the model reads their extracts and says which are worth
 * opening, or that none are; it answers from those; it checks its own answer
 * against them. Four calls, and the only one that has to be right is the
 * answer — the rest are recognition, which is what a small model is good at.
 *
 * No embedding index yet, so this matches letters rather than meaning: a note
 * saying "Percent Plan Complete" is invisible to someone typing PPC. That is
 * the next thing worth building.
 */

export interface Passage {
	file: TFile;
	/** The lines that matched, with a little either side. */
	text: string;
	score: number;
	/**
	 * What to call this when offering it to the model, if not its filename.
	 *
	 * The deck being presented is a candidate like any other, but its file name
	 * in a list of notes does not read as "the thing on screen" — so it says so.
	 */
	label?: string;
}

export interface Answer {
	/** What the model said, or null when nothing was found to answer from. */
	text: string | null;
	/** The notes the answer was drawn from, in the order they were offered. */
	sources: TFile[];
}

/** Only ever this machine. The whole promise of the feature is in this line. */
export function isLocal(url: string): boolean {
	return /^https?:\/\/(127\.0\.0\.1|localhost|\[::1\])(:\d+)?(\/|$)/i.test(url);
}

/**
 * Is there anything to ask?
 *
 * A model cannot be shipped with a plugin — it is gigabytes, it is someone
 * else's to license, and no plugin should be putting binaries on a machine. So
 * most people will never have one, and a button that has never worked and never
 * explains itself is worse than no button: they will press it, get a notice,
 * and conclude the plugin is broken.
 *
 * The controls appear when there is something behind them. Until then the
 * feature is invisible, the settings panel explains what it needs, and
 * everything else in the deck works exactly as before.
 */
export function hasModel(settings: {
	askUrl: string;
	askWhere: string;
	cloudKey: string;
}): boolean {
	return isLocal(settings.askUrl) || (settings.askWhere !== "local" && !!settings.cloudKey);
}

/**
 * Words that are never the subject.
 *
 * The second group is the one that earned its place. "Can you brief me on the
 * department business plan" has exactly one rare word in it — "brief" — and it
 * appears in one note of a hundred and eighty-three, which is a note about
 * something else entirely. That note became the only candidate and answered
 * the question. Words describing the asking have to be thrown away before
 * anything is weighed, or the phrasing outvotes the subject.
 */
const STOP = new Set([
	"the", "and", "for", "with", "that", "this", "from", "was", "were", "are",
	"what", "when", "which", "who", "how", "did", "does", "has", "have", "had",
	"about", "into", "there", "their", "they", "them", "then", "than", "you",
	"your", "our", "will", "would", "can", "could", "should", "any", "all",
	// How people ask, rather than what they ask about.
	"brief", "tell", "give", "show", "please", "pls", "explain", "summary",
	"summarise", "summarize", "need", "want", "check", "know", "find", "look",
	"more", "also", "some", "thing", "things", "let", "make", "help",
	"question", "answer", "note", "notes", "say", "said", "says", "get",
]);

/**
 * What a question is pointing at.
 *
 * "Summarise the canvas I am presenting now" is not a search. Nothing in the
 * vault is *about* the open deck, so a search returns whichever notes happen
 * to share a word — which is exactly how that question got answered out of two
 * unrelated site plans. No amount of better ranking fixes it, because the
 * right source was never a candidate: it is the thing on screen.
 *
 * So the question is read for what it names before anything is searched.
 * Obsidian has a small, stable vocabulary for the thing in front of you, and
 * presenting has another; people type whichever is in their head. Both are
 * listed here, in one place, so there is somewhere to add the next word.
 */
export type Scope = "slide" | "deck" | "note" | "vault";

/**
 * Words that mean "the one in front of me" rather than "one somewhere in my
 * vault". Without one of these, "what did the depot note say" is an ordinary
 * search and must stay one.
 */
const HERE = [
	"this", "these", "that", "current", "currently", "active", "open", "opened",
	"present", "presenting", "presented", "showing", "shown", "onscreen",
	"here", "now", "front", "looking", "am", "im", "are", "were", "re", "we",
	"i", "my",
];

/**
 * The nouns, most specific first: a slide is on a deck, a deck is a file.
 *
 * `always` marks the words that only ever mean the one in front of you. Nobody
 * writes a note *about* "the deck" or "the canvas", so "summarise the deck"
 * needs no pointing word — where "the depot note" plainly does, or every
 * question mentioning a note would stop being a search.
 */
const THINGS: { scope: Scope; words: string[]; always?: boolean }[] = [
	{ scope: "slide", words: ["slide", "card", "screen"] },
	{
		scope: "deck",
		words: ["deck", "canvas", "presentation", "slideshow", "slides", "board"],
		always: true,
	},
	{
		scope: "note",
		words: ["note", "notes", "document", "doc", "file", "page", "writeup", "minutes"],
	},
];

/** Asked with no noun at all — "what am I presenting", "what is on screen". */
const BARE =
	/\b(on|to|at) ?(screen|the screen)\b|\b(what'?s?|which)\b.{0,24}\b(presenting|onscreen|in front of (me|us)|looking at)\b/;

/**
 * Which thing the question is about, or `vault` if it is an ordinary search.
 *
 * A noun only counts when a pointing word sits within three words of it, on
 * either side. That proximity is the whole guard: "the current tender in the
 * depot note" keeps "current" attached to the tender, where it belongs, and
 * stays a search — while "the note I have open" and "this note" do not.
 */
export function scopeOf(question: string): Scope {
	const q = question.toLowerCase();
	if (BARE.test(q)) return "deck";
	// "what is on slide 4" points at the deck as surely as "this slide" does,
	// without a pointing word anywhere in it.
	if (/\b(slide|card|page)s?\s*(number\s*|no\.?\s*|#)?\d+/.test(q)) return "deck";

	const words = q.split(/[^a-z0-9]+/).filter(Boolean);
	const pointing = words.map((w) => HERE.includes(w));

	for (const { scope, words: nouns, always } of THINGS) {
		for (let i = 0; i < words.length; i++) {
			if (!nouns.includes(words[i])) continue;
			if (always) return scope;
			for (let j = Math.max(0, i - 3); j <= Math.min(words.length - 1, i + 3); j++) {
				if (j !== i && pointing[j]) return scope;
			}
		}
	}
	return "vault";
}

function terms(question: string): string[] {
	return [
		...new Set(
			question
				.toLowerCase()
				.split(/[^a-z0-9]+/)
				.filter((w) => w.length > 2 && !STOP.has(w))
		),
	];
}

/**
 * A drawing wearing a note's clothes.
 *
 * Excalidraw stores a drawing as markdown, and its text layer is a list of
 * labels: `PUMP ROOM ^wZO6W1cY` on its own line, a shape's caption and a block
 * reference. Twenty-one of them in a working vault, each matching on a word
 * and contributing a fragment that answers nothing — and the model, told to
 * use only what the notes say, dutifully read one back as an answer.
 */
function isDrawing(body: string, path: string): boolean {
	if (/\.excalidraw(\.md)?$/i.test(path)) return true;
	// The frontmatter key the plugin writes, within the first few lines.
	return /^---[\s\S]{0,400}excalidraw-plugin:/m.test(body);
}

/**
 * A note, cut into passages that stand on their own.
 *
 * Matching lines with one either side was the old rule, and it cut thoughts in
 * half: asked what the intake valve does, the model was handed a single table
 * row naming it and answered that the intake valve is part of the intake
 * valve. True, and useless — there was nothing else in the passage.
 *
 * Blocks break at blank lines and at headings, and a heading travels with the
 * text under it, so a passage arrives as a paragraph somebody wrote rather
 * than a window onto one.
 */
function chunksOf(body: string): { text: string; heading: string }[] {
	// Frontmatter is metadata, not prose, and it matches on everything.
	const without = body.replace(/^---\n[\s\S]*?\n---\n/, "");
	const out: { text: string; heading: string }[] = [];
	let heading = "";
	let buffer: string[] = [];

	const flush = () => {
		const text = buffer.join("\n").trim();
		buffer = [];
		if (text) out.push({ text, heading });
	};

	for (const line of without.split("\n")) {
		if (/^#{1,6}\s/.test(line)) {
			flush();
			heading = line.replace(/^#+\s*/, "").trim();
			continue;
		}
		if (line.trim() === "") {
			flush();
			continue;
		}
		buffer.push(line);
		// A table or a long list is one block, but not an unbounded one.
		if (buffer.length >= 40) flush();
	}
	flush();
	return out;
}

/** Obsidian's block references mean nothing to a reader, or to a model. */
function clean(text: string): string {
	return text
		.replace(/\s\^[A-Za-z0-9-]{4,}\b/g, "")
		.replace(/[ \t]+$/gm, "");
}

function filesIn(app: App, folder: string): TFile[] {
	if (!folder) return app.vault.getMarkdownFiles();
	const dir = normalizePath(folder);
	const root = app.vault.getAbstractFileByPath(dir);
	if (!(root instanceof TFolder)) return [];
	const out: TFile[] = [];
	const walk = (f: TFolder) => {
		for (const child of f.children) {
			if (child instanceof TFolder) walk(child);
			else if (child instanceof TFile && child.extension === "md") out.push(child);
		}
	};
	walk(root);
	return out;
}

/**
 * The passages worth showing a model.
 *
 * Every note is scored on the weight of the question's words it carries, with
 * a word in its title worth extra. From each, the two best paragraphs — not
 * whole notes, which would spend the model's context on the twenty-nine
 * paragraphs that had nothing to do with the question.
 *
 * This is a shortlist, not an answer. Which of these are actually about the
 * question is decided afterwards, by a model looking at the extracts.
 */
export async function findPassages(
	app: App,
	folder: string,
	question: string,
	limit = 6
): Promise<Passage[]> {
	const words = terms(question);
	if (words.length === 0) return [];

	// Read once, then decide. Which words are worth anything cannot be known
	// until you know how common they are here.
	const read: { file: TFile; body: string; lower: string }[] = [];
	for (const file of filesIn(app, folder)) {
		try {
			const body = await app.vault.cachedRead(file);
			if (isDrawing(body, file.path)) continue;
			// The path is searched along with the text. A note called "EDMS -
			// General Notes" can say "EDMS" nowhere in its body — people title a
			// note for its subject and then stop repeating the word — and
			// matching bodies alone made it invisible to anyone asking about
			// EDMS. The name is where the subject is most reliably written down.
			read.push({ file, body, lower: `${file.path}\n${body}`.toLowerCase() });
		} catch {
			// Unreadable notes are simply not candidates.
		}
	}

	/**
	 * What each word is worth here.
	 *
	 * A word in one note of a hundred and eighty-three tells you almost
	 * everything; a word in forty-seven tells you almost nothing. Counting
	 * matches equally pulled in half the vault — but letting the single rarest
	 * word decide was no better, because the rarest word in a question is often
	 * a turn of phrase rather than the subject. Weighing them all, and adding
	 * the weights, means three ordinary words about the right thing beat one
	 * freak word about the wrong one.
	 */
	const weight = new Map<string, number>();
	for (const w of words) {
		const df = read.filter((r) => r.lower.includes(w)).length;
		if (df > 0) weight.set(w, Math.log(read.length / df));
	}
	if (weight.size === 0) return [];

	const scored: Passage[] = [];
	for (const { file, body, lower } of read) {
		const present = words.filter((w) => lower.includes(w));
		if (present.length === 0) continue;

		// A note about the thing beats a note mentioning it, so its name counts.
		const named = present.some((w) => file.basename.toLowerCase().includes(w));
		const base = present.reduce((t, w) => t + (weight.get(w) ?? 0), 0) + (named ? 1 : 0);

		// The two best passages in the note, judged the same way — a paragraph
		// carrying three of the words is worth more than one carrying the same
		// word three times.
		const blocks = chunksOf(body)
			.map((c) => {
				// The heading travels with its paragraph: "Decisions" above a
				// bullet is most of what that bullet means.
				const text = c.heading ? `${c.heading}\n${c.text}` : c.text;
				const low = text.toLowerCase();
				const carried = words.filter((w) => low.includes(w));
				return {
					text,
					score: carried.reduce((t, w) => t + (weight.get(w) ?? 0), 0),
				};
			})
			.filter((c) => c.score > 0)
			.sort((left, right) => right.score - left.score)
			.slice(0, 2);

		// Matched by its name and by nothing in its text: show what it opens
		// with. The alternative is dropping a note that is plainly about the
		// subject because it does not repeat its own title.
		if (blocks.length === 0) {
			if (!named) continue;
			const opening = chunksOf(body).slice(0, 2);
			if (opening.length === 0) continue;
			blocks.push(
				...opening.map((c) => ({
					text: c.heading ? `${c.heading}\n${c.text}` : c.text,
					score: 0,
				}))
			);
		}

		scored.push({
			file,
			text: clean(blocks.map((b) => b.text).join("\n\n")).slice(0, 1400),
			score: base + blocks[0].score,
		});
	}

	scored.sort((a, b) => b.score - a.score);
	return scored.slice(0, limit);
}

/**
 * Put the question to a local model, with only what was found.
 *
 * It may use the passages and nothing else. An answer that is only a citation
 * is discarded in code rather than shown as a finding.
 */
export interface AskConfig {
	where: "local" | "local-first" | "cloud-first";
	url: string;
	model: string;
	cloudKey: string;
	cloudModel: string;
}

/** Which model actually answered, so the reader is never left guessing. */
export interface Answered {
	text: string;
	from: "local" | "cloud";
}

/**
 * Put the question to whichever model policy allows, in order.
 *
 * `local` never contacts anything but this machine, whatever else is
 * configured — a setting that says local has to mean it. The other two say out
 * loud which one answered, because "this went to OpenAI" is not a thing to
 * learn afterwards.
 */
export async function askBest(
	config: AskConfig,
	question: string,
	passages: Passage[],
	history: { q: string; a: string }[] = []
): Promise<Answered | null> {
	if (passages.length === 0) return null;
	// The last two questions, and not the answers to them.
	//
	// Carrying the answers made a follow-up drag the previous reply forward:
	// asked for a summary of the laser layout trial, it kept returning to the
	// robotic total station from the question before, and embellished — "Proof
	// of Concept", "software" — with words no note contained. The questions
	// alone are enough to say what "it" refers to, which is all history is for
	// here. Fresh passages are retrieved every time, so the notes remain the
	// only source.
	const recent = history.slice(-2).map((t) => ({ role: "user", content: t.q }));
	const messages = [
		{ role: "system", content: SYSTEM },
		...recent,
		{ role: "user", content: buildUser(question, passages) },
	];

	const local = async (): Promise<Answered | null> => {
		const text = await ask(config.url, config.model, question, passages, recent);
		return text ? { text, from: "local" } : null;
	};
	const cloud = async (): Promise<Answered | null> => {
		const text = await askCloud(config.cloudKey, config.cloudModel, messages);
		return text ? { text, from: "cloud" } : null;
	};

	if (config.where === "local") return local();
	if (config.where === "cloud-first") return (await cloud()) ?? (await local());
	return (await local()) ?? (await cloud());
}

/**
 * OpenAI, when the policy allows it and a key is set.
 *
 * Held to exactly the same rule as the local model. A bigger model is not
 * licence to invent a decision nobody made.
 */
async function askCloud(
	key: string,
	model: string,
	messages: { role: string; content: string }[]
): Promise<string | null> {
	if (!key) return null;
	try {
		const response = await fetch("https://api.openai.com/v1/chat/completions", {
			method: "POST",
			headers: {
				"Content-Type": "application/json",
				Authorization: `Bearer ${key}`,
			},
			body: JSON.stringify({ model, messages, temperature: 0 }),
		});
		if (!response.ok) return null;
		const text = pickChat(await response.json())?.trim();
		return text && usable(text) ? text : null;
	} catch {
		return null;
	}
}

/**
 * The rules the answer is held to.
 *
 * Notably absent: any invitation to refuse. Telling a 3B model "reply NOT
 * FOUND if the notes do not contain the answer" made it reply NOT FOUND to a
 * question the notes answered in one line — measured, not guessed. A small
 * model over-weights an escape hatch and takes it.
 *
 * So refusing is not the model's job. Retrieval already knows whether anything
 * matched, and says so in code before a model is called at all. The model is
 * only ever asked to answer from text that demonstrably mentions the subject —
 * and if that text turns out not to answer the question, saying what it *does*
 * say is more useful than a refusal anyway.
 */
const SYSTEM =
	"Report what the notes say in relation to the question. Use only what the " +
	"notes state - never add general knowledge, reasons or explanations of your " +
	"own. Never guess, and never use the words likely, probably or presumably: if " +
	"you are inferring rather than reading, say only what the notes do contain. " +
	"Earlier messages are there only to tell you what the question refers to; " +
	"answer the latest question from the notes in the latest message. Do not " +
	"repeat the question. Write one to three plain sentences of your own. Never " +
	"copy a line, list item or table row back as your answer - write a sentence " +
	"about what it says.";

/**
 * Is there an answer in here, or only a citation?
 *
 * Asked something its notes could not answer, the model sometimes replies with
 * nothing but a note name — `(from Note: XER Data Str)`, or the bare title.
 * Shown in a panel that reads as an answer, that is worse than saying nothing:
 * it looks like a finding. Treated as no answer, the panel says so and lists
 * the sources instead.
 */
function usable(text: string): boolean {
	const bare = text
		.replace(/\(from[^)]*\)/gi, "")
		.replace(/^\s*note:\s*/i, "")
		.trim();
	return bare.length >= 20 && /\s/.test(bare);
}

/**
 * The notes, by name.
 *
 * Numbered `[1]`, `[2]` at first — and the model cited note 2 as note 1, which
 * is worse than no citation. Names cannot be mis-numbered, and the sources are
 * listed under every answer regardless.
 */
function buildUser(question: string, passages: Passage[]): string {
	// `--- name ---` read as a heading to reproduce, and the model echoed the
	// whole block back instead of answering. A plain `Note:` line does not.
	const context = passages
		.map((p) => `Note: ${p.label ?? p.file.basename}
${p.text}`)
		.join("\n\n");
	return `${context}\n\nQuestion: ${question}`;
}

export async function ask(
	url: string,
	model: string,
	question: string,
	passages: Passage[],
	history: { role: string; content: string }[] = []
): Promise<string | null> {
	if (!isLocal(url) || passages.length === 0) return null;

	const base = url.replace(/\/+$/, "");
	const messages = [
		{ role: "system", content: SYSTEM },
		...history,
		{ role: "user", content: buildUser(question, passages) },
	];

	// The OpenAI-shaped endpoint first, because both servers worth running
	// locally expose it: Ollama, and llama.cpp's own llama-server — which is
	// what you already have if a GGUF is sitting on disk. Falls back to
	// Ollama's native route for an older build that lacks it.
	const text =
		(await post(`${base}/v1/chat/completions`, {
			model,
			messages,
			temperature: 0,
			stream: false,
		}).then(pickChat)) ??
		(await post(`${base}/api/generate`, {
			model,
			prompt: `${SYSTEM}\n\n${buildUser(question, passages)}`,
			stream: false,
		}).then(pickGenerate));

	const answer = text?.trim();
	return answer && usable(answer) ? answer : null;
}

async function post(url: string, body: unknown): Promise<unknown | null> {
	try {
		const response = await fetch(url, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify(body),
		});
		if (!response.ok) return null;
		return (await response.json()) as unknown;
	} catch {
		return null;
	}
}

/** `choices[0].message.content`, the OpenAI shape both servers answer with. */
function pickChat(data: unknown): string | null {
	const choices = (data as { choices?: { message?: { content?: unknown } }[] })?.choices;
	const content = choices?.[0]?.message?.content;
	return typeof content === "string" ? content : null;
}

/** `response`, Ollama's own shape. */
function pickGenerate(data: unknown): string | null {
	const text = (data as { response?: unknown })?.response;
	return typeof text === "string" ? text : null;
}

/**
 * Turn what someone asked into what to search for.
 *
 * A hand-written stop list can drop "can you brief me", but it cannot know
 * that PPC is percent plan complete, or that "the valve" and "Intake Valve"
 * are the same thing. The model can, and it is the one step where a model
 * genuinely beats a rule.
 *
 * Best-effort throughout: if the server is slow, wrong or absent, the original
 * question is used and the search is no worse than it was before.
 */
export async function searchTerms(
	url: string,
	model: string,
	question: string
): Promise<string> {
	if (!isLocal(url)) return question;
	const system =
		"Turn the user's question into search keywords for their notes. Reply with " +
		"the keywords only, separated by spaces - no sentence, no punctuation, no " +
		"explanation. Drop words about the asking. Expand any abbreviation you " +
		"recognise, keeping the abbreviation too.";
	const data = await post(`${url.replace(/\/+$/, "")}/v1/chat/completions`, {
		model,
		temperature: 0,
		messages: [
			{ role: "system", content: system },
			{ role: "user", content: question },
		],
	});
	const text = pickChat(data)?.trim();
	// A model that returns a paragraph has misunderstood; a short line has not.
	if (!text || text.length > 120 || text.includes("\n")) return question;
	return `${question} ${text}`;
}

/**
 * Which of the candidates are actually worth reading.
 *
 * The step that makes the rest work. Word scores rank notes by how a question
 * is spelled; this ranks them by whether they bear on it — and because the
 * model chooses from a numbered list of notes that exist, it cannot invent one.
 *
 * It is also where "no note found" is finally decided well. Asked for the
 * budget for a swimming pool, every scoring rule tried here returned a
 * schedule line about a pool and courtyard, because the word was there. Shown
 * the extract and asked whether it bears on the question, the model says NONE —
 * which is the honest answer and the one no amount of counting produced.
 *
 * Asking it to invent better search terms instead was tried and was worse than
 * useless: it turned PPC into "pay-per-click", and misspelt a product name it
 * had just been shown. Recognising is a small model's strength; generating is
 * not.
 */
export async function chooseNotes(
	url: string,
	model: string,
	question: string,
	candidates: Passage[]
): Promise<Passage[]> {
	if (!isLocal(url) || candidates.length <= 1) return candidates;

	const list = candidates
		.map((p, i) => `${i + 1}. ${p.label ?? p.file.basename}
   ${p.text.replace(/s+/g, " ").slice(0, 220)}`)
		.join("\n");

	const data = await post(`${url.replace(/\/+$/, "")}/v1/chat/completions`, {
		model,
		temperature: 0,
		messages: [
			{
				role: "system",
				content:
					"You are choosing which of the user's notes to read in full. Each is " +
					"shown with a short extract. Reply with the numbers of the up to three " +
					"most likely to answer the question, separated by commas, for example: " +
					"2,5,9. Numbers only, nothing else. If none of them relate to the " +
					"question, reply: NONE",
			},
			{ role: "user", content: `${list}\nQUESTION: ${question}` },
		],
	});

	const said = pickChat(data)?.trim() ?? "";
	if (/^NONE/i.test(said)) return [];
	const picked = [...said.matchAll(/\d+/g)]
		.map((m) => candidates[Number(m[0]) - 1])
		.filter((p): p is Passage => !!p);
	// An unparseable reply is not a reason to throw the search away.
	return picked.length > 0 ? picked.slice(0, 3) : candidates.slice(0, 3);
}

/**
 * Check the answer against the passages it came from.
 *
 * The last line of defence, and the only one aimed at a claim that is fluent,
 * plausible and absent from the notes. The model is shown its own answer beside
 * the source and asked one question with two possible replies, which is about
 * as much judgement as a 3B can be trusted with.
 *
 * A failure to reach the server means the answer stands: a verifier that
 * silently deletes answers when it is unavailable would be worse than none.
 */
export async function verify(
	url: string,
	model: string,
	answer: string,
	passages: Passage[]
): Promise<boolean> {
	if (!isLocal(url)) return true;

	// An answer saying the notes do not cover something is, by construction,
	// not in the notes — and the verifier duly calls it unsupported. Checking
	// an absence against the thing it says is absent cannot work, so it is not
	// asked. These are the answers most worth keeping.
	if (/\b(do(es)? not|don't|doesn't|no)\b[^.]*\b(mention|say|state|provide|cover|contain|include|found)/i.test(answer)) {
		return true;
	}

	const notes = passages
		.map((p) => `${p.label ?? p.file.basename}\n${p.text}`)
		.join("\n\n");
	const data = await post(`${url.replace(/\/+$/, "")}/v1/chat/completions`, {
		model,
		temperature: 0,
		messages: [
			{
				role: "system",
				content:
					"You check whether a statement is supported by notes. Reply with one " +
					"word: SUPPORTED if everything in the statement appears in the notes, " +
					"or UNSUPPORTED if any part of it does not.",
			},
			{ role: "user", content: `NOTES:\n${notes}\n\nSTATEMENT:\n${answer}` },
		],
	});
	const said = pickChat(data)?.trim().toUpperCase() ?? "";
	if (!said) return true;
	return !said.startsWith("UNSUPPORTED");
}

/**
 * Look for a model server already running on this machine.
 *
 * A model cannot ship with the plugin, so the setup is: install a server, then
 * tell Atlas where it is. The second half is the part nobody should have to
 * look up — the two that people actually run listen on well-known ports, and
 * asking them takes a moment.
 *
 * Only ever localhost, and only when somebody presses the button.
 */
export async function findServer(): Promise<string | null> {
	// Ollama first: it is the one most people have, and the one the rest of the
	// Obsidian ecosystem assumes.
	for (const url of ["http://127.0.0.1:11434", "http://127.0.0.1:8080", "http://127.0.0.1:1234"]) {
		if ((await models(url))?.length !== undefined) return url;
	}
	return null;
}

/** What the server has, so the settings panel can say whether it is reachable. */
export async function models(url: string): Promise<string[] | null> {
	if (!isLocal(url)) return null;
	const base = url.replace(/\/+$/, "");

	const get = async (path: string): Promise<unknown | null> => {
		try {
			const response = await fetch(base + path);
			return response.ok ? ((await response.json()) as unknown) : null;
		} catch {
			return null;
		}
	};

	// Ollama's list, then the OpenAI-shaped one llama-server answers with — so
	// Test says "connected" for either server rather than only for Ollama.
	const tags = (await get("/api/tags")) as { models?: { name?: unknown }[] } | null;
	if (tags?.models) {
		return tags.models.map((m) => m.name).filter((n): n is string => typeof n === "string");
	}

	const list = (await get("/v1/models")) as { data?: { id?: unknown }[] } | null;
	if (list?.data) {
		return list.data.map((m) => m.id).filter((n): n is string => typeof n === "string");
	}
	return null;
}
