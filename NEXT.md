# Atlas Presenter — state at 0.34.1

**Not yet in the community store**: the review tool passes, but nothing has been
submitted — that is a pull request to obsidianmd/obsidian-releases, and there is
no such PR. Installed by BRAT or by hand until then. Lint, type-check and all
four audits clean; CI green on every release.
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

**A question naming what is on screen is not a search.** Nothing in a vault is
*about* the open deck, so "summarise the canvas I am presenting" matched two
unrelated site plans and answered from them. `scopeOf()` reads the question for
Obsidian's vocabulary (note, document, file, page) and presenting's (deck,
canvas, slide, card, screen) before anything is searched, and hands over the
deck or the card instead. A noun counts only with a pointing word within three
words of it, so "the depot note" stays a search; deck words need none.

**Four calls, shown as steps.** Rewrite, choose, answer, verify. Six seconds of
silence reads as a hang; the same six with the steps on screen reads as work.

**Local by default, and enforced.** Both the speech server and the model server
refuse a non-local address. The cloud option is a three-way setting, never a
silent fallback, and every answer says which model produced it.

## Left

1. **Embeddings.** Retrieval matches letters, not meaning, so a note saying
   "Percent Plan Complete" is invisible to someone typing PPC. nomic-embed-text
   was tested against three real failures and fixed one of them; the PPC case
   stayed wrong because the term is defined in no note in the vault, which no
   retrieval method can fix. Worth doing, but it is not the jump it looked like.
2. **The rest of "what I am looking at".** `scopeOf()` answers about the deck and
   the card. The same shape covers "what did I just say" (the journal), "what is
   in the note behind this card" (the linked file) and "what have we covered so
   far" (the stops up to now) — all state the app holds and search cannot reach.
3. **Background AI summaries.** Per-card summaries from a session transcript, cut
   by the visit timeline, landing in the `W` panel as editable drafts. Needs a
   local whisper server, which nobody has stood up yet.
4. **Per-card history.** Standing on slide 14, show what was noted there in past
   sessions. The minutes already carry `type: minutes` and `deck:` frontmatter, so
   it is a lookup.
5. **A chat window over a page.** Grounded in this deck, your notes, or a URL you
   name. Not web search — the chat API cannot browse, and implying it can is worse
   than not having it.
6. **The demo pack never reaches store users.** Releases ship three files; the
   seven themes, `_Template.css`, `Backdrops.css` and 24 backdrops live only in the
   repo. A command to write them into a vault would be about 20 KB in `main.js`.
7. **Never run on mobile.** No Node or Electron APIs, but nobody has opened it on
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
- A question about the deck answered from two notes that shared a word with it.

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


## Getting into the community store

Passing Obsidian's review tool is a pre-flight check, not a submission. Listing
is a pull request against
[obsidianmd/obsidian-releases](https://github.com/obsidianmd/obsidian-releases),
adding one entry to `community-plugins.json`:

```json
{
  "id": "atlas-presenter",
  "name": "Atlas Presenter",
  "author": "Preetesh",
  "description": "Present a Canvas as a map you fly across: edges set the running order, groups become sections, and you can jump to any card — or any note in your vault — mid-talk and land back exactly where you were.",
  "repo": "Preeteshgm/atlas-presenter"
}
```

The entry goes at the **end** of that array. What the reviewers check is already
in place: a release tagged with the bare version (no `v`), carrying `main.js`,
`manifest.json` and `styles.css` as loose assets — which the release workflow
does on every tag — plus `manifest.json` at the repo root, a README that says
what the plugin is, and a licence.

After the PR: a bot validates it within minutes, then a human review that can
take weeks. Until then BRAT installs it from the repo.
