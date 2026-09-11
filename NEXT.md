# Where things stand — 11 September 2026

Atlas Presenter is feature-complete against everything we listed this morning.
Working tree clean, `npm run check` passes, pushed to
[Preeteshgm/atlas-presenter](https://github.com/Preeteshgm/atlas-presenter).

## Built today

| | |
|---|---|
| Path variants | `#skip-exec` / `#only-exec`; **Present this canvas as…**; `variant:` default |
| HTML export | **`E`** — one file, media inlined, opens anywhere |
| Presenter window | **`P`** — second screen: notes, clock, next card, Back/Next |
| Note capture | **`N`** — a note against the card on screen, in a Modal so typing cannot leak |
| Minutes | Leaving writes up the session; **`W`** writes without leaving |
| Blank screen | **`B`** |
| Auto-advance | `advance: 8s` on the `#deck` card |
| Excalidraw | Drawings render as drawings |

## Genuinely left

1. **Nested canvases as sub-decks.** A `.canvas` card is still a signpost. `M`
   already reaches any card, so this buys less than it looks.
2. **PDF.** Deliberately skipped — printing flattens the camera. Print the
   exported HTML if paper is needed.
3. **Runtime testing.** Lint, type-check and the audit scripts pass; none of it
   has been watched running except by Preetesh. This is the real gap.

## Before submitting to the community store

- `authorUrl` is set. `fundingUrl` is not, if that is ever wanted.
- The review flags `innerHTML`. The defence: HTML cards are the feature, and
  script execution is **off by default**.
- Walk the five demo decks end to end first.

## Scripts

```
npm run check          lint + type-check
npm run install:vault -- -WithDemo
npm version patch && git push --follow-tags     cuts a release
```
