# Atlas Presenter — state at 0.6.1

Feature-complete against everything planned. All four audits clean, lint and
type-check pass, 32 commits, 15 releases, CI green.
[Preeteshgm/atlas-presenter](https://github.com/Preeteshgm/atlas-presenter)

## Built

| | |
|---|---|
| The deck | A camera over the canvas; edges are the order, groups are sections |
| `M` | The map of this canvas — jump anywhere, `Backspace` home |
| `G` | Obsidian's own graph view of the vault, with a way back |
| Peek | Click a wikilink and read the note over the deck |
| Cards | Markdown, `+++` reveals, `%%notes%%`, three picture layouts, HTML cards with live scripts, Excalidraw drawings |
| `#deck` card | Per-canvas header, theme, logo, transition, variant, auto-advance |
| Themes | Eight card roles; Paper, Slate and Plain |
| Variants | `#skip-x` / `#only-x` — one map, several talks |
| Sub-decks | A `.canvas` card drawn to scale; `Enter` presents it |
| `E` | Export to one standalone HTML file; print it for PDF |
| `P` | Presenter window on a second screen |
| `N` / `W` | Remark against a card; review the session and write it up |
| `B`, timer, rail | Blank the screen, elapsed and clock, progress |

## Left

1. **Runtime testing.** Everything here is verified by lint, type-check and four
   audit scripts. They have never caught a *wrong interaction* — the invisible
   remark, the vanishing minutes, the caption-sized title and the scripts that
   silently did nothing were all found by presenting. That is still the only way.
2. **Community store submission.** Everything the review checks is in place. It
   needs you to submit through the developer dashboard.

## For the submission

- Public repo, MIT, `authorUrl` set, `versions.json` in step with the manifest.
- No default hotkey; Vault API over Adapter API; leaves untouched on unload.
- **Expect `innerHTML` to be flagged.** The answer: HTML cards are the feature,
  they render into a shadow root, and **script execution is off by default**.
- `isDesktopOnly: false` is accurate — no Node or Electron APIs are used — but
  Atlas has never been run on mobile. The popout window will not open there; it
  is caught and reported rather than breaking.

## Scripts

```
npm run check                     lint + type-check
npm run audit                     all four sweeps
npm run install:vault -- -WithDemo
```

Releasing: bump `package.json`, `manifest.json` and `versions.json` together,
commit, tag with the bare version (`0.6.2`, never `v0.6.2`), push the tag. CI
lints, verifies the tag matches the manifest, builds and attaches the assets.
