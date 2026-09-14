# Atlas Presenter — state at 0.7.0

Feature-complete against everything planned. All four audits clean, lint and
type-check pass, CI green.
[Preeteshgm/atlas-presenter](https://github.com/Preeteshgm/atlas-presenter)

## Built

| | |
|---|---|
| The deck | A camera over the canvas; edges are the order, groups are sections |
| `M` | The map of this canvas — jump anywhere, `Backspace` home |
| `G` | Obsidian's own graph view of the vault, with a way back |
| Peek | Click a wikilink and read the note over the deck |
| Cards | Markdown, `+++` reveals, `%%notes%%`, three picture layouts, HTML cards with live scripts, Excalidraw drawings |
| Roles | `#title` `#section` `#quote` `#stat` `#dark` `#agenda` `#end` `#full` `#split` |
| Placed layouts | `#two` `#compare` `#left` `#right` — split the card at a `---` rule |
| Tables and lists | Styled for a slide on every card, themed or not |
| `#deck` card | Per-canvas header, theme, logo, transition, variant, auto-advance |
| Themes | Paper, Slate and Plain |
| Variants | `#skip-x` / `#only-x` — one map, several talks |
| Sub-decks | A `.canvas` card drawn to scale; `Enter` presents it |
| `E` | Export to one standalone HTML file; print it for PDF |
| `P` | Presenter window on a second screen |
| Two windows | "Present in a separate window" — deck on the projector, canvas still yours |
| `N` / `W` | Remark against a card; review the session and write it up |
| `B`, timer, rail | Blank the screen, elapsed and clock, progress |

## New in 0.7.0

- **The deck can take a window of its own.** `useOwnWindow()` opens a popout
  holding a `DeckView`, and the presentation builds itself into *that* window's
  document — `doc` and `win` are fields now, not the globals. The main Obsidian
  window is never touched, so the canvas, notes and minutes stay in front of
  you. In this mode `G` opens the graph on your screen and the projector keeps
  showing the card, rather than the deck stepping aside.
- **Speaker notes can no longer leak to the room.** With a presenter window
  open, `%%notes%%` come off the deck itself and no setting overrides it. Before
  this, "Speaker notes on screen" put them on the audience display.
- **Placed layouts.** `layOutPanes()` splits a tagged card's rendered body at
  its `<hr>`s into `.atl-pane` wrappers — CSS can put children in two columns
  but cannot say *which* children, so the card says, with a `---`. A leading
  block of nothing but headings becomes a band across the top. `+++` reveals are
  gathered per pane so a reveal cannot jump out of its column.
- **Tables and lists styled.** They were rendering with Obsidian's own note CSS
  — 14px, vault colours — inside a themed card the camera then scales up. Every
  colour is written `var(--token, <Obsidian fallback>)`, so one block in
  `styles.css` serves both a themed deck and an unthemed one.

## Left

1. **Runtime testing.** Everything here is verified by lint, type-check and four
   audit scripts. They have never caught a *wrong interaction* — the invisible
   remark, the vanishing minutes, the caption-sized title and the scripts that
   silently did nothing were all found by presenting. That is still the only way.
   For 0.7.0 specifically: walk the last row of `5 · Cheat sheet`, which is the
   new layouts demonstrating themselves, and try both ways of presenting.
2. **Community store submission.** Everything the review checks is in place. It
   needs you to submit through the developer dashboard.

## Known edges

- Closing the presenter window by hand does not put notes back on the deck; the
  deck has no hook for that. It fails closed, which is the safe direction.
- `#left` / `#right` find the picture side with `:has()`. Fine on Obsidian 1.5+
  (Chromium 105+), but it is the one modern selector relied on.

## For the submission

- Public repo, MIT, `authorUrl` set, `versions.json` in step with the manifest.
- No default hotkey; Vault API over Adapter API; leaves untouched on unload.
- **Expect `innerHTML` to be flagged.** The answer: HTML cards are the feature,
  they render into a shadow root, and **script execution is off by default**.
- `isDesktopOnly: false` is accurate — no Node or Electron APIs are used — but
  Atlas has never been run on mobile. Neither popout window will open there;
  both are caught and reported rather than breaking.

## Scripts

```
npm run check                     lint + type-check
npm run audit                     all four sweeps
npm run install:vault -- -WithDemo
```

Releasing: bump `package.json`, `manifest.json` and `versions.json` together,
commit, tag with the bare version (`0.7.1`, never `v0.7.1`), push the tag. CI
lints, verifies the tag matches the manifest, builds and attaches the assets.
