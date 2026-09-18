# Writing decks with an assistant

A brief for an assistant asked to produce Atlas decks on demand: what to write,
in what shape, and the handful of rules that make the difference between a
canvas that presents and one that has to be fixed by hand.

Paste this into whatever the assistant reads before it starts — a project's
standing instructions, a system prompt, the top of the conversation — and give it
`README.md` and one demo canvas as well. The README is the full reference; this is what
to do with it.

---

## What you are producing

A `.canvas` file — [JSON Canvas](https://jsoncanvas.org), the format Obsidian
writes. Atlas turns one into a talk by walking its arrows. Nothing is exported,
converted or built: the canvas *is* the deck.

Output a complete JSON document, ready to save as
`<Vault>/<Folder>/<Deck name>.canvas`. Never output a fragment with "…add the
rest" in it — a canvas with one malformed node fails to open at all.

```json
{
  "nodes": [
    { "id": "deck", "type": "text", "text": "#deck\n\ntheme: Atlas/Themes/Slate.css\n\n# Title\nSubtitle", "x": 0, "y": -1180, "width": 1000, "height": 420 },
    { "id": "s1", "type": "text", "text": "#title\n\n# Opening\nOne line beneath", "x": 0, "y": 0, "width": 1280, "height": 720 },
    { "id": "g1", "type": "group", "label": "Section name", "x": -80, "y": -80, "width": 4000, "height": 880 }
  ],
  "edges": [{ "id": "e1", "fromNode": "s1", "toNode": "s2" }]
}
```

Node types: `text` (a card, markdown), `file` (a note, image, PDF or `.html`
card, by vault path), `link` (a URL), `group` (a section box). Every node needs
`id`, `x`, `y`, `width`, `height`. Ids are yours to choose; keep them short and
meaningful (`s1`, `risk-2`) so edges stay readable.

## Geometry that reads well

- **Cards are 1280 × 720** — 16:9, the shape of the screen. Use 1280 × 860 when
  a card runs long. Keep one size per section; mismatched cards look accidental.
- **240 px of air** between cards, so `x` steps by 1520 along a row and `y` by
  960 down a column.
- **A section is a group box** drawn 80 px outside the cards it holds, with a
  `label`. The label becomes the section name in the deck, the header `{section}`
  token, and a zoom-out overview stop before the section's first card.
- **Rows read left to right, sections stack downward.** Put the `#deck` card
  above everything, clear of the groups.

## The order of the talk

Atlas walks the arrows depth-first from the starting card: a branch is told to
its end before the next one begins. So **draw the arrows in the order you want
to speak**, and branch only where the talk genuinely forks.

- `#start` on a card begins there whatever the arrows say; otherwise the card
  with no arrow coming in wins.
- Cards no arrow ever reaches still appear, in reading order, at the end.
- Number the edges (`"label": "1."`) when the canvas is also read by eye.

## The `#deck` card

One text node tagged `#deck`. It is never presented. `key: value` lines above
the first blank line are settings; everything below is the title block, and it
is markdown.

```
#deck

theme: Atlas/Themes/Slate.css
logo: Assets/ours.png, Assets/client.png
header: {deck}  ·  {section}  ·  {n}/{total}

# Deck title
Subtitle · **Name** · *{section}*
```

Keys: `theme:` (a `.css` file by full vault path — a theme brings its own
backdrop, so it is usually the only line needed), `backdrop:` (any CSS
background), `image:` + `dim:`, `colour:`, `logo:` (comma-separated for a row),
`logo corner:`, `logo height:`, `accent:`, `header:`, `variant:`, `advance:`
(`8s`, for an unattended loop), `fit:`, `align:`, `transition:`.

Every key is also a `{token}` usable in `header:`, alongside `{deck}`,
`{section}`, `{n}`, `{total}`, `{date}`.

## The card roles

A line holding nothing but tags is an instruction: it is stripped before the
card is drawn. Every Atlas theme implements the same role names, so a deck
written against one theme works against all of them — **never write CSS into a
card**; pick a role instead.

| Tag | The card becomes |
|---|---|
| *(none)* | A card: heading and text |
| `#title` | The opening card |
| `#section` | A divider carrying the section name |
| `#quote` | A pull quote |
| `#stat` | One large number and a line about it |
| `#agenda` | A running order, one line to a row |
| `#end` | The closing card |
| `#dark` | The same card, inverted |
| `#full` | A picture with no margin |
| `#split` | Two flowed columns |

Variants: `#skip-short` leaves a card out of the talk called *short*;
`#only-short` keeps it for that talk alone. No tag means every talk.

## Writing the cards themselves

- **One idea to a card.** If a card needs a scroll bar it is two cards.
- **Six lines is a lot.** A card is read at four metres, not held in the hand.
- Speaker notes go in `%%` comments, or in the linked note under a `## Notes`
  heading; they never reach the slide.
- `![[Image.png]]` embeds; a `file` node pointing at an image is the same thing
  with room to place it.
- For full control, point a `file` node at a `.html` file in the vault. It is
  rendered in a shadow root with the theme's tokens available, so use
  `var(--ink)`, `var(--paper)`, `var(--accent)`, `var(--rule)` rather than
  literal colours, and it will follow the deck's theme.

## Placing a block

`:::pin <place>` puts a block against the card, out of the flow. `:::align
<place>` puts it inside its column, still in the flow. Nine places for both —
`top-left top top-right left centre right bottom-left bottom bottom-right` — and
`row` lays the block across instead of down.

```markdown
:::pin top-right row
![[a.png|90]] ![[b.png|90]]
:::
```

Advanced Slides' `<grid drag="40 60" drop="topright">…</grid>` is accepted as
written and means the same thing.

## The deck card opens the talk

Anything under the `#deck` card's settings is the **banner**: a real card, given
the `#banner` role, presented first. Do not size it — Atlas does, from the first
section. `#band` puts the first block across the top of any split card;
`#noband` keeps it in its column.

## Sizing a picture

`![[plan.png|420]]` is 420 wide with the shape kept; `![[plan.png|420x260]]`
forces that box. The number is pixels on the **card**. Several pictures on one
line become a row.

## The rules worth repeating

1. **Complete JSON, always.** Validate mentally: every node has all five
   required fields, every edge's `fromNode`/`toNode` names a node that exists.
2. **Paths are vault-relative** and case-sensitive on sync — `Atlas/Themes/Slate.css`,
   not `./Slate.css` or an absolute path.
3. **No CSS in a card.** Roles and themes, so the deck restyles in one line.
4. **Say what you assumed.** If the deck needs an image, a logo or a theme that
   may not exist, name the path you used and say it must be in place.


### Pictures, cropping and edges

`![[plan.png|420]]` is 420 wide with the shape kept; `![[plan.png|420x160]]` is
that box exactly — **filled and cropped**, never stretched. Several embeds on
one line become a row, and the number is pixels on the card, not on the screen.

A picture that fills a pane or a box is cropped from the middle. Four card tags
change that: `#focus-left`, `#focus-right` and `#focus-centre` choose which part
survives, and `#fade-left`, `#fade-right` and `#fade-both` dissolve the
picture's edge into the card rather than cutting it off. They are meant to pair
— keep the far end, fade the near one — and they work on the `#deck` card's
banner like any other card.

`#gallery`, `#scroll` and `#slideshow` show several pictures: a grid, a stack,
and one at a time with arrows and dots. Write one embed per line; a line of
words above them stays above them.

### Two markdown traps

Obsidian joins consecutive lines into one paragraph, and `---`, `+++` and the
picture containers all work on blocks — Atlas spaces the markers itself now, but
a blank line around them is never wrong. And `---` directly under a line of text
is a *heading* in markdown, not a rule; on a card tagged for columns Atlas
corrects that, on an untagged card it leaves markdown alone.
