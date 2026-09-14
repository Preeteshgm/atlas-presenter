# Atlas Presenter — state at 0.26.0

Feature-complete and tested by hand end to end. Lint, type-check and all four
audits clean; CI green on every release.
[Preeteshgm/atlas-presenter](https://github.com/Preeteshgm/atlas-presenter) ·
[handbook](https://preeteshgm.github.io/atlas-presenter/)

## What it is

A canvas presented as a map you fly across. Edges are the running order, groups
are the sections, and nothing is converted — the canvas file *is* the deck.

| | |
|---|---|
| Present | The deck opens in a tab of its own. Drag it to any screen, `F` for fullscreen |
| `O` | The overview — drag, scroll, `Ctrl`+wheel to zoom, `0` shows all, click a card |
| `M` | The schematic map — titles, order, section names |
| `G` | Obsidian's graph, with a way back |
| Peek | A wikilink opens the note over the deck; a web link opens the page over it |
| Cards | Markdown, `+++` reveals, `%%notes%%`, four picture layouts, HTML cards with live scripts, Excalidraw |
| Roles | `#title` `#section` `#quote` `#stat` `#dark` `#agenda` `#end` `#full` `#split` |
| Placed layouts | `#two` `#compare` `#left` `#right` — split at a `---` rule |
| `#deck` card | Per-canvas theme, header, logo, accent, backdrop, variant, auto-advance |
| Variants | `#skip-x` / `#only-x` — one map, several talks |
| `N` / `W` | A remark against a card; the session reviewed and written up as minutes |
| `E` | One standalone HTML file, which behaves like the deck. Print it for a PDF |
| Preview | The exported file running in a tab beside the canvas, with Refresh |

## Left

1. **Community store submission.** Everything the review checks is in place. It
   needs you to submit through the developer dashboard.
2. **Never run on mobile.** `isDesktopOnly: false` is accurate — no Node or
   Electron APIs, and the tab model made it more true than the popout did — but
   nobody has opened it on a phone. Flipping it to `true` costs nothing.
3. **Untested by anyone:** printing the export to PDF; a talk longer than a few
   minutes (auto-advance, the timer past an hour); a deck of a couple of hundred
   cards; an Excalidraw drawing, because the demo pack has none; someone else's
   vault, theme and plugins.

## For the submission

- Public repo, MIT, `authorUrl` set, `versions.json` in step with the manifest.
- No default hotkeys; Vault API over Adapter API; leaves untouched on unload; no
  telemetry; no network calls.
- **Expect `innerHTML` to be flagged.** The answer: HTML cards are the feature,
  they render into a shadow root, and **script execution is off by default**.

## What this last stretch taught, worth keeping

Every audit passed the whole way through. They caught the leaks — unstopped
events, dead settings, missing rules. They caught none of these:

- `#gallery`, `#slideshow` and `#scroll` were documented in four places, styled,
  demonstrated in four decks, and **never implemented** for a markdown card.
- `---` under a line of text is a heading, not a rule, so every placed layout
  whose column ended in a bullet silently came out as one column.
- `instanceof HTMLElement` is false for elements from another window, which broke
  clicks, the column layouts and peek — but only once a deck was dragged out.
- A modal cannot be seen over a fullscreen element, so `N`, `W` and `G` each did
  nothing at the one moment they were most wanted.
- The deck listens in the capture phase, so typing a remark drove the deck.

All five rendered *something*, which is the worst way for anything to fail. Each
was found by presenting.

## Scripts

```
npm run check                     lint + type-check
npm run audit                     all four sweeps
npm run install:vault -- -WithDemo
```

Releasing: bump `package.json`, `manifest.json` and `versions.json` together,
commit, tag with the bare version (`0.26.1`, never `v0.26.1`), push the tag. CI
lints, verifies the tag matches the manifest, builds and attaches the assets.
