---
cssclasses:
  - atlas-reference
---

# How to write a card

Keep this open beside the canvas — **Ctrl+P → Open in new pane**, or drag this
note's tab to the right-hand sidebar and it stays there while you draw.

Everything here is markdown you type **inside a canvas card**. Nothing needs
HTML. The first line of a card can be a line of nothing but tags: that line
never reaches the screen.

---

## Start here: what do you want?

| I want… | Write |
|---|---|
| An opening slide | `#title` |
| A divider between sections | `#section` |
| Two columns | `#two`, split with `---` |
| Three or four columns | `#band`, split with `---` |
| A heading across the top of the columns | add `#band` |
| The first block to stay a column | add `#noband` |
| Today against proposed | `#compare` |
| A picture on one side, words on the other | `#left` or `#right` |
| One big number | `#stat` |
| A quotation | `#quote` |
| A running order | `#agenda` |
| A point that should land | `#dark` |
| A picture filling the card | `#full` |
| Text flowing from column to column | `#split` |
| A closing card | `#end` |
| A block somewhere specific | `:::pin` |
| A block at the foot of its column | `:::align` |
| One line at a time | `+++` |
| Several pictures | `#gallery`, `#scroll` or `#slideshow` |

---

## Columns

A card splits at `---` rules, but **only if it is tagged for it**. Untagged,
`---` stays a rule and the blocks stack.

```
#band
# Reporting
What everything upstream is for.
---
### The model
Quantities, taken off the live model.
---
### The programme
P6 activities joined on the activity code.
---
### The report
Power BI, refreshed against both.
```

- **`#two`** — two columns. It also splits into three or four if you write more
  blocks; the name is the common case, not a limit.
- **`#band`** — splits the card, and the **first block runs across the top**.
- **`#noband`** — splits the card, and **every block is a column**, including
  the first.
- **`#compare`** — two columns, each in its own panel. For *today / proposed*.
- **`#left` / `#right`** — the picture side is full bleed; the words side has
  its margins.

Say neither `#band` nor `#noband` and the old rule holds: a first block of
nothing but headings becomes a band, anything else is a column.

Four columns is the widest that reads. Five will fit and nobody will follow it.

---

## Putting a block where you want it

`:::pin` places a block against the **card** and lifts it out of the flow.
`:::align` leaves it in the flow and places it inside its **column**.

```
:::pin bottom-right
![[logo.png|140]]
:::

:::align bottom-left
The foot of this column.
:::
```

Nine places for both:

`top-left` `top` `top-right` `left` `centre` `right` `bottom-left` `bottom`
`bottom-right`

- Add `row` to lay the block across instead of down: `:::pin bottom-right row`
- Coordinates instead of a name: `:::pin 20,70` is x,y in percent of the card
- A size after it: `:::pin 75,30 0.2x0.2` is width and height as fractions
- The closing `:::` is only needed when something follows it in the same column
- **A pin overlaps the flow.** Do not pin `top-left` on a card with a heading

Advanced Slides' `<grid drag drop>` works as written, so a deck carried over
from it keeps running.

---

## Pictures

```
![[plan.png]]           the picture's own size, capped by the card
![[plan.png|420]]       420 wide, shape kept
![[plan.png|420x160]]   that box exactly — filled and cropped, never stretched
```

The number is pixels on the **card**, not on the screen; the card is scaled to
the screen afterwards, so the same card looks the same on any projector.

- **Several on one line become a row**, with the theme's gap between them.
  Sizes can differ; they line up on their middles.
- **A picture is a block.** Text after it sits under it, not beside it. For
  side by side use `#left`, `#right`, or a `:::pin`.
- **A cropped picture is cropped from the middle.** To keep one end, tag the
  card `#focus-left` or `#focus-right`. `#focus-centre` is the default.
- A caption is just a line of italic text under the picture.
- An SVG stays sharp at any size; prefer one for diagrams and marks.

### Several pictures

| Tag | What you get |
|---|---|
| `#gallery` | A grid of cells |
| `#scroll` | Full width, stacked, scrolling |
| `#slideshow` | One at a time, with arrows and dots. → moves between them |

Write one embed per line. A line of words above them is fine — it stays above
the pictures rather than joining them.

---

## One thing at a time

```
The first point is here.
+++
The second arrives on the next press.
+++
And the third after that.
```

`+++` divides the card into frames. The first frame shows straight away; every
press adds the next. Printing or exporting shows them all at once.

---

## The deck card

One card tagged `#deck` dresses the whole canvas. It is never presented as an
ordinary card — but anything written **below the settings** becomes the
**banner**: the opening slide, sized for you, presented first, and not counted
in the card numbers.

```
#deck

theme: Atlas/Themes/Paper.css
image: Atlas/Backdrops/Harbour fall.svg
dim: 0.35
logo: Atlas/Assets/mark.png
header: {deck}  ·  {section}
presenter: A. Name

# Northwind Depot
The controls upgrade · **A. Name**
```

### The keys

| Key | What it does |
|---|---|
| `theme:` | A `.css` file in the vault. Brings its own backdrop |
| `backdrop:` | Any CSS background — a colour or a gradient |
| `image:` + `dim:` | A picture behind the cards, and how far to darken it (0–1) |
| `colour:` | A flat colour behind the cards |
| `logo:` | A vault image on every slide. Several, comma separated, sit in a row |
| `header:` | The line at the foot of the screen |
| `section:` | How a section overview is framed — `title`, `contain`, `whole` |
| `fit:` | `contain` shows the whole card; `cover` fills and crops |
| `advance:` | Run by itself — `advance: 8s`. Any key stops it |
| `variant:` | Which talk to present by default |
| `align:` | `centre` or `top`, for a card that does not fill the height |

Any key of your own — `presenter:`, `client:`, `status:` — becomes usable in
`header:`.

### The header line

`{deck}` `{section}` `{n}` `{total}` `{date}` plus any key you wrote yourself.

The bar **always** shows the position on its right, so leave `{n}/{total}` out
unless you want it twice. Leave `header:` out entirely and the bar shows
breadcrumbs.

---

## Notes while you present

- **N** writes a remark on the card you are on
- **R** speaks one; **Shift+R** records the meeting
- A card carrying a note wears a **dot**; a ring round it means it was spoken
- All of it lives in **one note per deck**, beside the canvas, with the
  canvas's own name and a section per card — edit it like any note
- `%%like this%%` inside a card is a speaker note: never on screen

---

## Two traps worth knowing

**Blank lines matter.** Obsidian joins consecutive lines into one paragraph. A
card written

```
The first point.
+++
The second.
```

is one paragraph, and `+++`, `---` and picture-gathering all work on *blocks*.
Atlas fixes the common cases for you now, but if something refuses to split,
put a blank line around the marker.

**`---` under a line of text makes a heading** in markdown, not a rule. On a
card tagged for columns Atlas corrects that. On an untagged card it does not,
because a heading written that way is a legitimate thing to write.

---

## What still needs HTML

Three things, and only three:

1. **Tabs** — anything you click to swap content
2. **A drawn diagram** — boxes with arrows between them
3. **Live data or animation** — a chart, a counter, a script

Everything else — columns, placement, icon rows, status chips, sizing — is on
this page.

---

## Where else to look

- **Settings → Atlas** has the same reference, always current with the build
- `Atlas/5 · Cheat sheet.canvas` — the short version, as a deck
- `Atlas/10 · Every combination.canvas` — one card per feature, numbered
- `Atlas/11 · Pictures and media.canvas` — every way to put a picture on a card
- `Atlas/9 · Themes and backdrops.canvas` — writing a theme of your own
- `Atlas/Themes/_Template.css` — every theme token, with comments
