"""Does the demo pack actually demonstrate every feature, and does it all resolve?"""
import io
import json
import os
import re

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

PACK = os.path.join(ROOT, "demo", "Atlas")

FEATURES = {
    "deck card (#deck)": r"(^|\n)[ \t]*#deck[ \t]*(\n|$)",
    "reveals (+++)": r"(^|\n)\+\+\+[ \t]*(\n|$)",
    "speaker notes (%%)": r"%%[\s\S]+?%%",
    "tag hooks (#title/#dark/...)": r"(^|\n)[ \t]*#(title|section|quote|stat|dark|split|full)\b",
    "wikilink peek": r"\[\[[^\]]+\]\]",
    "image embed": r"!\[\[[^\]]+\.(png|jpe?g|svg|webp)\]\]",
    "gallery (grid)": r"atl-gallery",
    "slideshow (one at a time)": r"atl-slideshow",
    "scroll (a column)": r"atl-scroll",
    "HTML card (slide-html)": r"```slide-html",
    "steps in HTML (.step)": r'class="[^"]*\bstep\b',
    "enter/leave events": r"atlas:(enter|leave)",
    "long scrolling card": r"### Part \d",
}
FILE_FEATURES = {
    "audio card": r"\.(webm|wav|mp3|m4a)$",
    "html file card": r"\.html$",
    "image file card": r"\.(png|jpe?g|svg|webp)$",
    "note card": r"\.md$",
    "heading slice (subpath)": None,
}

found = {k: [] for k in list(FEATURES) + list(FILE_FEATURES)}
found["group (section)"] = []
found["orphan card"] = []
found["card colours"] = []
problems = []

for name in sorted(f for f in os.listdir(PACK) if f.endswith(".canvas")):
    data = json.load(io.open(os.path.join(PACK, name), encoding="utf-8"))
    nodes, edges = data["nodes"], data["edges"]
    short = name.split(" ")[0]

    blob = "\n".join(n.get("text", "") for n in nodes)
    for label, pattern in FEATURES.items():
        if re.search(pattern, blob, re.M):
            found[label].append(short)

    for n in nodes:
        if n.get("type") == "file":
            rel = n["file"].replace("Atlas/", "")
            if not os.path.exists(os.path.join(PACK, rel.replace("/", os.sep))):
                problems.append("%s: missing asset %s" % (name, n["file"]))
            for label, pattern in FILE_FEATURES.items():
                if pattern and re.search(pattern, n["file"], re.I):
                    found[label].append(short)
            if n.get("subpath"):
                found["heading slice (subpath)"].append(short)
        if n.get("type") == "group":
            found["group (section)"].append(short)
        if n.get("color"):
            found["card colours"].append(short)

    ids = {n["id"] for n in nodes}
    reached = {e["toNode"] for e in edges} | {e["fromNode"] for e in edges}
    slides = [n for n in nodes
              if n["type"] != "group" and not re.search(FEATURES["deck card (#deck)"],
                                                        n.get("text", ""), re.M)]
    orphans = [n["id"] for n in slides if n["id"] not in reached]
    if orphans:
        found["orphan card"].append(short)
    for e in edges:
        if e["fromNode"] not in ids or e["toNode"] not in ids:
            problems.append("%s: edge %s points at a missing card" % (name, e["id"]))

print("FEATURE COVERAGE ACROSS THE DEMO PACK")
missing = []
for label in sorted(found):
    decks = sorted(set(found[label]))
    if decks:
        print("  + %-30s %s" % (label, ", ".join(decks)))
    else:
        missing.append(label)
        print("  - %-30s NOT DEMONSTRATED" % label)

print("\nPROBLEMS" if problems else "\nNo broken references.")
for p in problems:
    print("  !", p)
if missing:
    print("\n%d feature(s) with no example." % len(missing))
