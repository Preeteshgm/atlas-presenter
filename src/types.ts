/** Subset of the Obsidian `.canvas` (JSON Canvas) file format that we care about. */

type CanvasNodeType = "text" | "file" | "link" | "group";

export interface CanvasNode {
	id: string;
	type: CanvasNodeType;
	x: number;
	y: number;
	width: number;
	height: number;
	color?: string;
	/** type: "text" */
	text?: string;
	/** type: "file" */
	file?: string;
	subpath?: string;
	/** type: "link" */
	url?: string;
	/** type: "group" */
	label?: string;
}

export interface CanvasEdge {
	id: string;
	fromNode: string;
	toNode: string;
	fromSide?: string;
	toSide?: string;
	label?: string;
	color?: string;
}

export interface CanvasData {
	nodes: CanvasNode[];
	edges: CanvasEdge[];
}

export interface Rect {
	x: number;
	y: number;
	width: number;
	height: number;
}

/** A single beat of the presentation: where the camera goes and what is in frame. */
export interface Stop {
	/** "node" frames one card; "group" zooms out to frame a whole section. */
	kind: "node" | "group";
	node: CanvasNode;
	/** The group this stop lives inside, if any. Used for breadcrumbs. */
	group?: CanvasNode;
}

export interface Scene {
	/** Keys from the canvas's #deck card, if it has one. */
	meta: Record<string, string>;
	data: CanvasData;
	/** Slide-bearing nodes, i.e. everything that is not a group. */
	slides: CanvasNode[];
	groups: CanvasNode[];
	stops: Stop[];
	bounds: Rect;
	/** node id -> the innermost group containing it */
	groupOf: Map<string, CanvasNode>;
}

export type BackgroundMode = "theme" | "colour" | "image";
export type FitMode = "contain" | "cover";
/** "obsidian" hands over to the real graph view; "builtin" stays in the deck. */
export type BrowserMode = "obsidian" | "builtin";
export type SlideshowTransition = "fade" | "slide" | "slide-up" | "zoom" | "flip";
export type HeaderPosition = "top-left" | "top-centre" | "top-right";
/** Where the deck header is worth showing. */
export type HeaderScope = "sections" | "always" | "first";
/** Where a framed card sits when it does not fill the height. */
export type VerticalAlign = "centre" | "top";
export type TimerMode = "off" | "elapsed" | "clock" | "both";
/** Where a question may be answered — and whether notes may leave this machine. */
export type AskWhere = "local" | "local-first" | "cloud-first";
export type Corner = "top-left" | "top-right" | "bottom-left" | "bottom-right";

export interface AtlasSettings {
	// --- movement ---
	/** Extra breathing room around a framed card, as a fraction of its size. */
	padding: number;
	/** Camera flight duration in ms. */
	duration: number;
	/** Zoom out to the whole map before diving into a new section. */
	sectionOverviews: boolean;
	/** Max scale, so a tiny card does not fill the screen with 400pt text. */
	maxScale: number;
	/** "contain" shows the whole card; "cover" fills the screen and crops. */
	fit: FitMode;

	// --- look ---
	/**
	 * Where the backdrop and logo pickers look for images.
	 *
	 * Empty means the whole vault, which is where this started and which is
	 * unusable in a vault of any age: every screenshot, every pasted diagram,
	 * every attachment, in one list. Pointing it at a folder makes the pickers
	 * a shortlist somebody curates rather than everything that happens to be
	 * an image.
	 */
	mediaFolder: string;
	background: BackgroundMode;
	backgroundColour: string;
	/** Vault path to a background image. */
	backgroundImage: string;
	/** How far to darken a background image, 0–1, so text stays readable. */
	backgroundDim: number;
	/** Accent colour override; empty means follow the Obsidian theme. */
	accent: string;
	/** Opacity of cards that are not the current one, 0–1. */
	inactiveOpacity: number;

	// --- branding ---
	/** Vault path to a logo shown on every slide. */
	logo: string;
	logoCorner: Corner;
	logoHeight: number;
	logoOpacity: number;

	// --- chrome ---
	browser: BrowserMode;
	/** Vault path to a .css file applied to every deck. */
	themeCss: string;
	/** Run <script> inside HTML cards. Off by default — see the README. */
	allowScripts: boolean;
	/** How one image gives way to the next inside a card. */
	slideshowTransition: SlideshowTransition;
	/** "contain" shows all of each picture; "cover" fills the frame and crops. */
	slideshowFit: "contain" | "cover";
	/** A standing line above the deck. Tokens: {deck} {section} {n} {total} {date} */
	headerText: string;
	headerPosition: HeaderPosition;
	headerScope: HeaderScope;
	/** Show a group's name, large, while the camera frames the whole group. */
	sectionTitles: boolean;
	verticalAlign: VerticalAlign;
	/** Show %%speaker notes%% on screen, under the card. */
	/** Show the title of the card coming next. */
	showNext: boolean;
	/** A rail across the top showing progress, ticked at each section. */
	showProgress: boolean;
	timer: TimerMode;
	/** Where a written-up session is filed. Recordings go in a folder under it. */
	minutesFolder: string;
	/**
	 * A speech server on this machine, which turns a recording into text.
	 *
	 * Empty by default, and it stays empty unless someone sets it. Audio is the
	 * most sensitive thing a deck produces — a meeting nobody agreed to send
	 * anywhere — so recording works entirely offline, and posting it to
	 * something is a decision made on purpose rather than a default. Only a
	 * local address is accepted, for the same reason.
	 */
	transcribeUrl: string;
	/**
	 * A model server on this machine — Ollama, or anything speaking its API.
	 *
	 * Empty by default. Same reasoning as the speech server: notes are the most
	 * private thing in a vault, and only a local address is accepted.
	 */
	askUrl: string;
	/** Which model answers. Cheap to change, so it is a setting rather than a choice. */
	askModel: string;
	/** Where questions are answered from. Empty means the whole vault. */
	askFolder: string;
	/**
	 * Which model answers, and whether notes may leave the machine.
	 *
	 * Three states rather than a fallback flag, because "use the cloud when the
	 * local one is unavailable" can quietly mean "your meeting notes went to a
	 * third party because a server was not running" — and that is not something
	 * anyone should discover afterwards. `local` is the default and never sends
	 * anything anywhere.
	 */
	askWhere: AskWhere;
	/**
	 * An OpenAI key, if you have chosen to use one.
	 *
	 * Stored in this plugin's data file, which lives inside the vault — so it
	 * travels with any sync, backup or repository the vault is part of. The
	 * settings panel says so where the field is.
	 */
	cloudKey: string;
	cloudModel: string;
	/** Write the minutes on leaving a deck, when anything was noted. */
	minutesOnExit: boolean;
	/** Put the cards' own %%notes%% into the write-up. Off: they are private. */
	minutesIncludeNotes: boolean;
	/** Open the exported file in your browser as soon as it is written. */
	openExport: boolean;
	/** Appended to every action, e.g. a tag the Tasks plugin can query. */
	actionSuffix: string;
	/** Link each action back to the card it came from. */
	actionsLinkBack: boolean;
	showHud: boolean;
	showCounter: boolean;
	autoplayMedia: boolean;
}

export const DEFAULT_SETTINGS: AtlasSettings = {
	padding: 0.05,
	duration: 900,
	sectionOverviews: true,
	maxScale: 2.5,
	fit: "contain",

	mediaFolder: "",
	background: "theme",
	backgroundColour: "#0e1424",
	backgroundImage: "",
	backgroundDim: 0.45,
	accent: "",
	inactiveOpacity: 0.45,

	logo: "",
	logoCorner: "top-right",
	logoHeight: 40,
	logoOpacity: 0.9,

	browser: "obsidian",
	themeCss: "",
	allowScripts: false,
	slideshowTransition: "slide",
	slideshowFit: "contain",
	headerText: "",
	headerPosition: "top-centre",
	headerScope: "sections",
	sectionTitles: true,
	verticalAlign: "centre",
	showNext: false,
	showProgress: true,
	timer: "off",
	minutesFolder: "Meetings",
	transcribeUrl: "",
	askUrl: "",
	askModel: "qwen2.5:3b",
	askFolder: "Meetings",
	askWhere: "local",
	cloudKey: "",
	cloudModel: "gpt-4o-mini",
	minutesOnExit: true,
	minutesIncludeNotes: false,
	openExport: true,
	actionSuffix: "",
	actionsLinkBack: true,
	showHud: true,
	showCounter: true,
	autoplayMedia: true,
};
