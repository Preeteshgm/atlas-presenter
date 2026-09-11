# Northwind Depot — controls plan, rev A

The note behind the deck. Opened from a slide with a click, closed with Escape,
without leaving the presentation.

## The activity code

`ND-B2-L01-STR-CL-102` decomposes to project, building, level, discipline,
element type and sequence. Because the location is inside the code, a commitment
is made against an activity and nothing else.

## Why not the task id

| | v5 to v6 |
| --- | --- |
| Task ids that survived | 0 of 24,180 |
| Activity codes that matched | 24,173 of 24,180 |

The scheduling tool re-issues task ids on every export, so anything keyed on them
breaks the moment the programme is re-imported.

## Open questions

- Write-back needs a decision on status and percent-complete fields.
- Two slab names in the programme remain to be reconciled.
- 19,402 activities carry no task type.

## Related

Sequence, scope and schema are all on the canvas — press `M` for the map.
