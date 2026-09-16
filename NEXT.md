# Atlas Presenter — state at 0.29.0

Live in the Obsidian community store. Lint, type-check and all four audits clean;
CI green on every release.
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
| `G` | Obsidian's graph, with a way back. Deliberately nothing else on that bar |
| Peek | A wikilink opens the note over the deck; a web link opens the page over it |
| Cards | Markdown, `+++` reveals, `%%notes%%`, four picture layouts, HTML cards, Excalidraw |
| Roles | `#title` `#section` `#quote` `#stat` `#dark` `#agenda` `#end` `#full` `#split` |
| Placed layouts | `#two` `#compare` `#left` `#right` — split at a `---` rule |
| `#deck` card | Per-canvas theme, backdrop, header, logos, accent, variant, auto-advance |
| Themes | Seven, plus `_Template.css`. A theme is a list of values; the roles live in the plugin |
| Backdrops | 24 gradients as `--backdrop` one-liners and as SVG files |
| `N` / `R` | A remark against a card, typed or spoken |
| `Shift`+`R` | The whole meeting recorded, indexed by card in the write-up |
| `W` | The session reviewed and written up as minutes |
| Ask | A question put to your own notes, answered by a model on your machine |
| `E` | One standalone HTML file, which behaves like the deck. Print it for a PDF |

## Rules worth not relearning

**A theme dresses the whole deck.** Every colour reads its Atlas token first and
falls back to Obsidian: `var(--rule, var(--background-modifier-border))`. Roles
live in `styles.css`, not in each theme — they were copied three times, so a deck
with no theme had no roles at all.

**Nothing is only in memory.** Notes and visits are journalled as they happen; a
running recording is flushed every two minutes. The journal is deleted only once
the minutes exist.

**Refusing is decided on evidence.** The model is shown each candidate's extract
and asked which bear on the question; NONE is a valid reply and is how "no note
found" is settled. Word counts never could: ten notes matched "budget swimming
pool" because one of them mentions a pool.

**Recognising, never generating.** Telling a 3B to reply NOT FOUND made it refuse
questions the notes answered, twice, in two different phrasings. Letting it
invent second-round search terms turned PPC into "pay-per-click", and misspelt a
product name it had just been shown. It rewrites a query, picks from a list of
real notes, and checks an answer against its sources — never asked to produce
something that has to be right.

**Four calls, shown as steps.** Rewrite, choose, answer, verify. Six seconds of
silence reads as a hang; the same six with the steps on screen reads as work.

**Local by default, and enforced.** Both the speech server and the model server
refuse a non-local address. The cloud option is a three-way setting, never a
silent fallback, and every answer says which model produced it.

## Left

1. **Embeddings.** Retrieval still matches letters, not meaning — a note saying
   "Percent Plan Complete" is invisible to someone typing PPC. nomic-embed-text is
   about 275 MB and is the last big accuracy jump available.
2. **Background AI summaries.** Per-card summaries from a session transcript, cut
   by the visit timeline, landing in the `W` panel as editable drafts. Needs a
   local whisper server, which nobody has stood up yet.
3. **Per-card history.** Standing on slide 14, show what was noted there in past
   sessions. The minutes already carry `type: minutes` and `deck:` frontmatter, so
   it is a lookup.
4. **A chat window over a page.** Grounded in this deck, your notes, or a URL you
   name. Not web search — the chat API cannot browse, and implying it can is worse
   than not having it.
5. **The demo pack never reaches store users.** Releases ship three files; the
   seven themes, `_Template.css`, `Backdrops.css` and 24 backdrops live only in the
   repo. A command to write them into a vault would be about 20 KB in `main.js`.
6. **Never run on mobile.** No Node or Electron APIs, but nobody has opened it on
   a phone.

## What testing keeps proving

Static analysis has never once caught a wrong interaction on this project. Lint,
type-check and four audits passed continuously while these shipped broken:

- `#gallery`, `#slideshow` and `#scroll` were documented, styled, demonstrated —
  and never implemented.
- `---` under a line of text is a heading, so placed layouts silently came out as
  one column.
- `instanceof HTMLElement` is false across windows, which broke clicks and peek.
- `theme: ` with the value deleted captured the trailing space and overrode
  Settings with a one-character path.
- An `feTurbulence` filter on a fill-less `<rect>` renders solid black.
- The NOT FOUND instruction above.

Every one rendered *something*. Each was found by using it.

## Scripts

```
npm run check                     lint + type-check
npm run audit                     all four sweeps
npm run install:vault -- -WithDemo
```

Releasing: bump `package.json`, `manifest.json` and `versions.json` together,
commit, tag with the bare version (`0.29.0`, never `v0.29.0`), push the tag. CI
lints, verifies the tag matches the manifest, builds, attests and attaches.
