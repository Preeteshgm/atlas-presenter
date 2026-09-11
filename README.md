# Atlas Presenter

Turn an Obsidian **Canvas** into a presentation. Not a stack of slides — a camera
flying across a map of your notes.

Advanced Slides gives you one markdown file split by `---`. Atlas Presenter gives
you the canvas you already drew: cards keep their positions, edges become the
running order, groups become sections, and you can leave the path at any moment
and come back.

![A canvas, its edges and groups, and the camera arcing between cards](docs/canvas-to-deck.svg)

---

## Install

### Into a vault on this machine

```powershell
npm install
npm run vaults                       # lists the vaults Obsidian knows about
npm run install:vault                # builds, then installs
npm run install:vault -- -WithDemo   # and copies the demo decks in
```

The script reads Obsidian's own vault list, so you rarely type a path. Then enable
**Atlas** in **Settings → Community plugins**.

### From a release

Download `atlas-presenter-x.y.z.zip`, unzip into `<vault>/.obsidian/plugins/`. You
should end up with `<vault>/.obsidian/plugins/atlas-presenter/main.js`.

### With BRAT

Install **BRAT**, then *Add a beta plugin for testing* and paste this repo's URL.
Tags must be bare version numbers (`0.1.0`, never `v0.1.0`).

---

## Presenting

`Ctrl+Shift+P`, the ribbon icon, or right-click a canvas in the file explorer.
**With a card selected, the deck opens on that card**; with nothing selected it
starts at the beginning.

| Key | |
|---|---|
| `→` `Space` `PageDown` | Reveal, then the album, then scroll, then the next card |
| `←` `PageUp` | Back, the same way |
| **`M`** | The map of this canvas — click any card to fly to it |
| **`G`** | Obsidian's graph view of the whole vault |
| `Backspace` | Return from a jump, or one level out of a peeked note |
| `O` | Zoom out to the whole map |
| `Home` `End` | First and last card |
| `F` | Fullscreen |
| `Esc` | Close the map or the note, then leave the deck |

Clicking the right two-thirds advances, the left third goes back. Clicking a
control inside a card never advances the slide.

---

## How a canvas becomes a deck

| Canvas | Presentation |
|---|---|
| Card | A slide |
| Card position and size | Where the camera goes and how far it zooms |
| Edge | The path from one card to the next |
| Edge label starting with a number | Forces the running order |
| Group | A section — framed whole before diving in, named on the map |
| Card with no edges | Still on the map, reachable by jumping |
| Card colour | Mirrored on the map |

![The map overlay: every card to scale, numbered, the current one highlighted](docs/map.svg)

Traversal is depth-first: a branch is told to its end before the next begins. The
start is the card with outgoing edges and none incoming, or any card containing
`#start`. A canvas with no edges presents in reading order.

---

## Writing cards

Everything below is written on the canvas. Nothing needs a setting turned on, and
**no CSS ever goes in a card** — so a card is still a readable, shareable note.

### Markdown

Rendered through Obsidian itself, so wikilinks, embeds, Mermaid and Dataview all
work.

| | |
|---|---|
| `+++` on its own line | A reveal — `→` shows the next block before moving on |
| `%%…%%` | Speaker notes. Never drawn on the slide; optionally shown under it |
| `[[A note]]` | Click while presenting to read the whole note over the deck |
| `![[picture.png]]` | Images, video and audio embeds |
| `![[drawing.excalidraw]]` | Excalidraw drawings, rendered by that plugin |
| A very long card | Scrolls a screenful per press, then moves on |

### Pictures

![Gallery, slideshow and scroll compared](docs/layouts.svg)

Three layouts, all taking the same markup:

```html
<div class="atl-gallery">   <!-- all at once, side by side in a grid -->
<div class="atl-slideshow"> <!-- one at a time, in place, with dots -->
<div class="atl-scroll">    <!-- a column the card scrolls through -->
  <img src="Assets/a.png">
  <img src="Assets/b.png">
</div>
```

A slide show has dots, arrows, swipe (any direction) and five transitions. `→`
steps through it before leaving the card.

### Styling hooks, with no CSS in the card

| Hook | Selector |
|---|---|
| A line of bare tags — `#title #dark` | `.atl-tag-title`, `.atl-tag-dark` |
| `cssclasses:` frontmatter on a note | that class |
| The enclosing group | `[data-group="the-evidence"]` |

The tag line is stripped before rendering, so it never reaches the slide.

### HTML, when you want full control

````
```slide-html
<style> .hero { display: grid; place-items: center; } </style>
<div class="hero">Anything you like</div>
```
````

It renders into a shadow root, so a card's CSS cannot leak. `<script>` runs, so a
card can hold a toggle, a chart or an animation. A card that animates should stop
when off camera:

```js
const root = document.currentScript.getRootNode();
root.host.addEventListener('atlas:enter', start);
root.host.addEventListener('atlas:leave', stop);
```

A `.html` file dropped on the canvas behaves the same way. `note.md#Heading`
cards present just that section.

---

## The `#deck` card

One card, tagged `#deck`, is the deck's title block. **It is never presented** and
never appears on the map.

```
#deck

theme: Atlas/Theme.css
logo: Assets/client.png
accent: #1D5A78
transition: slide

### Northwind Depot — controls plan
**Sam Avery** · {section} · {date}
```

Anything that is not a `key: value` line is the header, **rendered as markdown**.
Every key becomes a token — `{title}`, plus built-in `{deck}` `{section}` `{n}`
`{total}` `{date}`.

These keys override the plugin settings **for this canvas alone**, so a client
deck and an internal deck can differ entirely with nothing in settings:

`theme:` `logo:` `logo corner:` `logo height:` `accent:` `colour:` `image:`
`dim:` `align:` `fit:` `transition:` `header on:` `header position:`

---

## Theming

Point **Settings → Background → Theme stylesheet** at a `.css` file in your vault.
It applies only while presenting — open the same card as a note and there is no
styling anywhere in it.

Four layers, later winning: Obsidian's theme → the plugin's `styles.css` → your
theme file → a `slide-html` card's own `<style>`. Your theme reaches inside HTML
cards too.

```css
.atl-overlay { --atl-accent: #1D5A78; --atl-inactive: 0.2; }
.atl-node:not(.atl-node-group) { background: #E6E9E1; }  /* see below */
.atl-node.is-active { }
.atl-node.atl-tag-title .atl-body { }
.atl-node[data-color="1"] { }        /* canvas colours 1–6 */
.atl-group-label { }                  /* the section name on the map */
.atl-body, .atl-hud, .atl-header { }
```

> **A group is also a `.atl-node`.** Styling `.atl-node` with a background paints
> a panel over the cards inside every group. Use `:not(.atl-node-group)`.

`demo/Atlas/Theme.css` is a commented, working example.

---

## Settings

| Section | |
|---|---|
| **Starting a presentation** | The shortcut, and a button to Obsidian's hotkey pane |
| **Camera** | Flight duration, section overviews, padding, contain/cover, maximum zoom |
| **Background** | Theme / colour / vault image with dimming, theme stylesheet, accent, off-camera card opacity |
| **Logo** | Any vault image, corner, height, opacity |
| **Slide shows** | Transition, contain/cover |
| **On screen** | Header line and where it shows, section titles, card alignment, speaker notes, next-card title, progress rail, timer |
| **Chrome** | Bottom bar, counter, video autoplay |
| **Writing cards** | The full authoring reference, with copyable snippets |

Settings are read when a deck **starts** — change them, then present.

---

## The demo

`npm run install:vault -- -WithDemo` copies one folder into the vault:

```
Atlas/
  1 · Start here.canvas     the rules, in the smallest deck that shows them
  2 · Themed deck.canvas    #title #section #quote #stat #dark #split #full
  3 · A real deck.canvas    a full plan: HTML slides and an animated card
  4 · Everything.canvas     a talk that happens to use every feature
  5 · Cheat sheet.canvas    every feature *with the syntax that produces it*
  Theme.css                 a commented example theme
  Assets/                   the slides, pictures and audio the decks point at
```

Start with **1**, present **5** when you want to look something up, and read
**4** to see what a finished deck feels like. They are built on an invented
project, so everything in them is safe to copy.

---

## Not built yet

Nested canvases as sub-decks (a `.canvas` card renders as a signpost), a presenter
view on a second screen, export to standalone HTML or PDF, and path variants — one
map, a five-minute and a forty-minute talk.

---

## Developing

`npm run dev` watches and rebuilds; the installer drops a `.hotreload` marker, so
with the **Hot Reload** plugin your changes apply without restarting.

```
src/
  main.ts              commands, hotkey, ribbon, canvas selection
  settings.ts          the settings tab and the authoring reference
  types.ts             canvas format, scene model, settings
  canvas/parse.ts      .canvas JSON, rects, group containment
  canvas/path.ts       edges -> running order, the #deck card
  present/presentation.ts  the deck: keys, chrome, stops
  present/camera.ts    pan, zoom, the arc between distant cards
  present/render.ts    cards -> DOM, media, reveals, styling hooks
  present/slideshow.ts the album inside a card
  present/minimap.ts   M — this canvas, drawn to scale
  present/browse.ts    G — the built-in vault graph
  present/peek.ts      reading a note without leaving the deck
```

Release: `npm version patch && git push --follow-tags`.
