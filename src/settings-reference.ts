import { Setting } from "obsidian";

/**
 * The authoring reference.
 *
 * None of this syntax is discoverable from the canvas editor, so it belongs
 * where someone will look for it rather than in a README they never opened. It
 * lives apart from the settings tab because it is not settings: nothing here
 * reads or writes a single option, and mixing the two meant the manual was
 * never read by anyone editing the panel.
 *
 * The same material, with room to breathe, is at
 * https://preeteshgm.github.io/atlas-presenter/ — keep the two in step.
 */
export function renderReference(containerEl: HTMLElement): void {
	new Setting(containerEl).setName("Writing cards").setHeading();

	const note = containerEl.createDiv({ cls: "atl-ref-lead" });
	note.setText(
		"Everything below is written on the canvas itself — in a card, on an edge, " +
			"or as a group. Nothing here needs a plugin setting turned on."
	);

	const section = (title: string) =>
		containerEl.createDiv({ cls: "atl-ref-section" }).createEl("h4", { text: title })
			.parentElement as HTMLElement;

	const entry = (host: HTMLElement, name: string, desc: string, code?: string) => {
		const row = host.createDiv({ cls: "atl-ref" });
		row.createDiv({ cls: "atl-ref-name", text: name });
		row.createDiv({ cls: "atl-ref-desc", text: desc });
		if (code === undefined) return;
		const box = row.createDiv({ cls: "atl-ref-code" });
		box.createEl("pre", { text: code });
		const copy = box.createEl("button", { cls: "atl-ref-copy", text: "Copy" });
		copy.addEventListener("click", async () => {
			await navigator.clipboard.writeText(code);
			copy.setText("Copied");
			window.setTimeout(() => copy.setText("Copy"), 1200);
		});
	};

	// ------------------------------------------------- every # line
	const hashes = section("Every # line");

	hashes.createDiv({
		cls: "atl-ref-lead",
		text:
			"A line holding nothing but tags is an instruction, and is removed before " +
			"the card is drawn \u2014 so it never reaches the slide. Markers change what a " +
			"card is; roles change how it looks.",
	});

	for (const [tag, what] of [
		["#deck", "This card is the deck's title block. It is never presented and never appears on the map. Its key: value lines set the header, the theme, the logo and more."],
		["#start", "Begin the deck here, whatever the arrows say."],
		["#skip-short", "Leave this card out of the talk called \u201cshort\u201d. It stays in every other one."],
		["#only-short", "Show this card in the \u201cshort\u201d talk and nowhere else."],
	] as [string, string][]) {
		entry(hashes, tag, what, tag);
	}

	const roles = section("The card roles");

	roles.createDiv({
		cls: "atl-ref-lead",
		text:
			"Every Atlas theme implements these same names, so a deck written against " +
			"one theme works against any of them. Put one at the top of a card.",
	});

	for (const [tag, what] of [
		["(no tag)", "An ordinary card: a heading and some text."],
		["#title", "The opening card \u2014 a large heading with a line beneath it."],
		["#section", "A divider carrying only the section's name, inverted, with a rule under it."],
		["#quote", "A pull quote, set large with an opening mark."],
		["#stat", "One large number, centred, with a line about it."],
		["#dark", "The same card, inverted. Useful for a point you want to land."],
		["#agenda", "A running order: the list is set large and numbered, one line to a row."],
		["#end", "The closing card — thanks, a contact, a next step, centred."],
		["#full", "A picture with no margin, filling the card."],
		["#split", "Two flowed columns — text spills out of the first into the second. For a deliberate split, use #two."],
	] as [string, string][]) {
		entry(roles, tag, what, tag === "(no tag)" ? undefined : tag);
	}

	// ------------------------------------------------- placed layouts
	const placed = section("Layouts you place yourself");

	placed.createDiv({
		cls: "atl-ref-lead",
		text:
			"These split the card at a --- rule, so you choose what goes where rather " +
			"than letting the text flow. Two blocks make two columns. A first block of " +
			"nothing but headings becomes a band across the top instead.",
	});

	entry(
		placed,
		"#two",
		"Two columns, side by side, equal width.",
		["#two", "# Spans both", "---", "The left column", "---", "The right column"].join("\n")
	);
	entry(
		placed,
		"#compare",
		"The same two columns, drawn as panels — for two things being weighed " +
			"against each other.",
		["#compare", "## Today", "- slow", "---", "## Proposed", "- quick"].join("\n")
	);
	entry(
		placed,
		"#left",
		"A picture filling the left half, text centred on the right.",
		["#left", "![[plan.png]]", "---", "## The layout", "What to look at."].join("\n")
	);
	entry(
		placed,
		"#right",
		"The mirror — text on the left, picture filling the right.",
		["#right", "## The layout", "What to look at.", "---", "![[plan.png]]"].join("\n")
	);

	placed.createDiv({
		cls: "atl-ref-lead",
		text:
			"Tables and bullet lists need no tag: they are styled for a slide on every " +
			"card, in your theme's colours, whether or not a theme is loaded.",
	});

	// ------------------------------------------------- on the canvas
	const canvas = section("On the canvas");

	entry(canvas, "Arrows set the order",
		"The deck follows the arrows between cards, depth first — a branch is told " +
			"to its end before the next one starts.");

	entry(canvas, "Numbered edge labels",
		"Label an arrow with a leading number to force the running order. Unlabelled " +
			"arrows fall back to the position of the card they point at.",
		`1.
2.
3. then this one`);

	entry(canvas, "Groups are sections",
		"Put cards inside a Canvas group and the camera frames the whole group on the " +
			"way in, then dives to its first card. The group name shows in the " +
			"breadcrumb and on the map.");

	entry(canvas, "No arrows at all",
		"A canvas with no edges still presents: cards run top to bottom, left to right.");

	entry(canvas, "Choosing the first card",
		"The start is the card with arrows out and none in. To override it, put #start " +
			"anywhere in a card.",
		"#start");

	entry(canvas, "Cards nothing points to",
		"Still part of the deck and still on the map. Press M and click one to fly " +
			"there, Backspace to come back. This is the card you keep for a question " +
			"you expect.");

	entry(canvas, "Canvas colours",
		"The colour you give a card in the editor is mirrored on the map, so a colour " +
			"can mean 'skip this in the short version'.");

	entry(canvas, "A section of a note",
		"Drop a note on the canvas, then set the card's link to a heading. Only that " +
			"section is presented.",
		"Note.md#Some heading");

	// ------------------------------------------------- inside a card
	const card = section("Inside a card");

	entry(card, "Reveals",
		"A line of three plus signs splits the card into steps. → shows the next one, " +
			"and only moves to the following card once they are all out.",
		`The claim.

+++

The evidence.

+++

The conclusion.`);

	entry(card, "Speaker notes",
		"Anything between double percent signs is stripped before the card is drawn. " +
			"Use it for the thing you meant to say.",
		"%%Slow down here. Ask whether anyone has seen the report.%%");

	entry(card, "Read a linked note",
		"Click a wikilink while presenting and the whole note opens over the slide. " +
			"Wheel or ↓ to scroll it, Esc to land back on the same slide.",
		"See [[Controls Plan]] for the detail.");

	entry(card, "Images",
		"Obsidian embeds work, and so does a plain img tag with a vault path.",
		"![[site-photo.png]]");

	entry(card, "Several images at once",
		"A gallery lays them out side by side, all visible together.",
		`<div class="atl-gallery">
` +
			`  <img src="Ref Images/a.png">
` +
			`  <img src="Ref Images/b.png">
` +
			"</div>");

	entry(card, "A column you scroll",
		"Stacked full width, one under the next. The card scrolls through them, "
			+ "so \u2192 walks down the pictures before moving on.",
		'<div class="atl-scroll">\n'
			+ '  <img src="Ref Images/a.png">\n'
			+ '  <img src="Ref Images/b.png">\n'
			+ "</div>");

	entry(card, "A slide show in one card",
		"The same images stacked instead. → steps through them without the camera " +
			"moving. Better than four cards when it is one idea.",
		`<div class="atl-slideshow">
` +
			`  <img src="Ref Images/a.png">
` +
			`  <img src="Ref Images/b.png">
` +
			"</div>");

	entry(card, "Excalidraw drawings",
		"A drawing is stored as markdown with its JSON inside, so it needs the "
			+ "Excalidraw plugin to become a picture. Drop the drawing on the canvas, "
			+ "or embed it — either way it renders as the drawing, not the file.",
		"![[Drawing 2026-01-14.excalidraw]]");

	entry(card, "Video and audio",
		"Drop the file on the canvas, or embed it. It starts when the camera arrives " +
			"and pauses when it leaves. Audio saved as .webm shows as a player bar.",
		"![[walkthrough.mp4]]");

	entry(card, "A card longer than the screen",
		"Just keep writing. The card scrolls a screenful per press and moves on when " +
			"it reaches the bottom — one long thought stays one card.");

	// ------------------------------------------------- html
	const html = section("Writing a card as HTML");

	entry(html, "A styled card",
		"Its CSS is sealed into a shadow root, so it cannot leak into the rest of the " +
			"deck and the deck cannot reach in. A .html file dropped on the canvas " +
			"behaves the same way.",
		`\`\`\`slide-html
` +
			`<style>
` +
			`  .hero { display: grid; place-items: center; height: 100%;
` +
			`          background: #141a2e; color: #e9ecf5; }
` +
			`</style>
` +
			`<div class="hero"><h1>Anything you like</h1></div>
` +
			"```");

	entry(html, "Reveals in HTML",
		"Give any element the class step and it becomes a reveal, in document order.",
		'<div class="step">appears on the next press</div>');

	entry(html, "Interactive cards",
		"Script tags run, so a card can hold a toggle, a chart or an animation. " +
			"Clicking a control does not advance the slide.");

	entry(html, "What a card script is given",
		"Two things are already in scope: root, the card's own shadow root, and "
			+ "host, the card element. Look things up through root — document sees "
			+ "a different tree and will find nothing. Anything that throws is "
			+ "shown on the card.",
		[
			"var box = root.querySelector('#chart');",
			"host.addEventListener('atlas:enter', start);",
		].join("\n"));

	entry(html, "Pausing an animation",
		"A card that animates should stop when it is off camera. Listen on the shadow " +
			"host for these two events.",
		`const root = document.currentScript.getRootNode();
` +
			`root.host.addEventListener('atlas:enter', start);
` +
			"root.host.addEventListener('atlas:leave', stop);");

	// ------------------------------------------------- keys
	const keys = section("Keys while presenting");
	for (const [k, what] of [
		["→  Space  PageDown", "reveal, then scroll, then the next card"],
		["←  PageUp", "back the same way"],
		["M", "the schematic map — titles and order, for a deck too big to read at once"],
		["G", "the graph of the whole vault"],
		["Backspace", "return from a jump, or one level out of a peeked note"],
		["O", "the overview — drag or scroll around the deck, Ctrl+wheel or +/− to zoom, 0 shows all, click a card to go there"],
		["Home  End", "first and last card"],
		["Enter", "dive into the sub-deck on this card"],
		["B", "blank the screen — attention on the room, not the slide"],
		["N", "note against the card on screen — the cursor goes to the presenter panel's box"],
		["W", "write the session up now"],
		["P", "the presenter panel — notes, the clock, what is next, and a box to write a remark in"],
		["E", "export the deck to one standalone HTML file"],
		["F", "fullscreen"],
		["Esc", "close the map or the note, then leave the deck"],
	] as [string, string][]) {
		const row = keys.createDiv({ cls: "atl-ref atl-ref-key" });
		row.createDiv({ cls: "atl-ref-name", text: k });
		row.createDiv({ cls: "atl-ref-desc", text: what });
	}

	// ------------------------------------------------- two screens
	const screens = section("Which command to use");

	screens.createDiv({
		cls: "atl-ref-lead",
		text:
			"Six commands, and one of them is the one you need day to day. They all " +
			"appear in the command palette under Atlas Presenter, and every one needs " +
			"a canvas to be the open tab.",
	});

	entry(
		screens,
		"Present",
		"The only one you need. The deck opens in a tab of its own, starting on the " +
			"card selected in the canvas. Drag that tab out to a window and put it on " +
			"whichever screen you like, then press F. Everything Obsidian opens \u2014 the " +
			"presenter panel, the graph, a peeked note \u2014 lands beside it, because a " +
			"tab is an ordinary leaf."
	);
	entry(
		screens,
		"Present from the beginning",
		"The same as Present, but ignores what is selected and starts at the first " +
			"card."
	);
	entry(
		screens,
		"Present a variant…",
		"Asks which talk to give, if the canvas has cards tagged #only-x or #skip-x."
	);
	entry(
		screens,
		"Stop presenting",
		"Ends the talk from this window. Escape works too, but it is on the deck's " +
			"own window — which may be behind something, or on a screen you cannot " +
			"see. Bind this one alongside a present command and you have a pair that " +
			"starts and stops a talk."
	);
	entry(
		screens,
		"Preview the export",
		"Opens the exported deck, running, in a tab beside the canvas. Press Refresh " +
			"after editing and it rebuilds. Nothing is written to the vault — this is " +
			"for seeing what the person you send the file to will actually get."
	);
	entry(
		screens,
		"Export to HTML",
		"Writes one standalone file to the vault root — the same as pressing E while " +
			"presenting, but it no longer needs a deck running. Export again and the " +
			"same file is overwritten — refresh the browser tab to see the change."
	);

	screens.createDiv({
		cls: "atl-ref-lead",
		text:
			"Atlas sets no hotkeys of its own, because defaults collide between " +
			"plugins. Assign your own under Settings → Hotkeys, searching for Atlas.",
	});

	screens.createDiv({
		cls: "atl-ref-lead",
		text:
			"Speaker notes are never shown in both places. The moment a presenter " +
			"window is open, %%notes%% come off the deck itself — whatever the " +
			"on-screen notes setting says — because the deck is what the room sees.",
	});
}
