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
	showNotes: boolean;
	/** Show the title of the card coming next. */
	showNext: boolean;
	/** A rail across the top showing progress, ticked at each section. */
	showProgress: boolean;
	timer: TimerMode;
	/** Where a written-up session is filed. */
	minutesFolder: string;
	/** Write the minutes on leaving a deck, when anything was noted. */
	minutesOnExit: boolean;
	/** Put the cards' own %%notes%% into the write-up. Off: they are private. */
	minutesIncludeNotes: boolean;
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
	showNotes: false,
	showNext: false,
	showProgress: true,
	timer: "off",
	minutesFolder: "Meetings",
	minutesOnExit: true,
	minutesIncludeNotes: false,
	actionSuffix: "",
	actionsLinkBack: true,
	showHud: true,
	showCounter: true,
	autoplayMedia: true,
};
