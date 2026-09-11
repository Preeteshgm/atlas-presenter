"""
Sweep for the failure we keep hitting: an event that acts, then travels on.

Every listener that changes something must also stop the event, or it reaches
Obsidian underneath — where the arrow keys move whichever card is selected.
Also lists the paths that can only fail when actually used, so they can be
tested deliberately rather than discovered.
"""
import io
import os
import re

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

SRC = os.path.join(ROOT, "src")

ACTING = re.compile(r"\b(this\.(advance|retreat|goTo|jumpTo|next|prev|stop|toggle|show|hide|"
                    r"captureNote|reviewSession|writeUp|openPresenter|openVaultGraph|"
                    r"enterSubdeck|exportToHtml|overview|back)|current\?\.(next|prev)|"
                    r"this\.(minimap|browser|peek)\.)\b")

files = []
for dirpath, dirnames, names in os.walk(SRC):
    dirnames[:] = [d for d in dirnames if d != "node_modules"]
    for n in names:
        if n.endswith(".ts"):
            files.append(os.path.join(dirpath, n))


def handler_body(text, start):
    """The block following an addEventListener( ... , handler."""
    depth = 0
    i = start
    began = False
    while i < len(text):
        c = text[i]
        if c == "{":
            depth += 1
            began = True
        elif c == "}":
            depth -= 1
            if began and depth == 0:
                return text[start:i + 1]
        i += 1
    return text[start:start + 1200]


risky = []
fine = 0
for path in files:
    rel = os.path.relpath(path, SRC)
    text = io.open(path, encoding="utf-8").read()
    for m in re.finditer(r'addEventListener\(\s*["\'](\w+)["\']', text):
        event = m.group(1)
        if event not in ("keydown", "keyup", "click", "dblclick", "wheel",
                         "pointerdown", "pointerup", "mousedown"):
            continue
        after = text[m.end(): m.end() + 80]
        # A named handler is defined elsewhere and checked there.
        if re.search(r",\s*this\.\w+\s*[,)]", after):
            fine += 1
            continue
        body = handler_body(text, m.end())
        acts = bool(ACTING.search(body))
        stops = "stopPropagation" in body or "handled()" in body or "swallow()" in body
        line = text[: m.start()].count("\n") + 1
        if acts and not stops:
            risky.append("%s:%d  %s handler acts but does not stop the event" % (rel, line, event))
        else:
            fine += 1

print("LISTENERS THAT ACT ON AN EVENT")
if risky:
    for r in risky:
        print("  !", r)
else:
    print("  every one of them stops the event  (%d checked)" % fine)

# Registered on a shared target, in either window.
print("\nLISTENERS ON A SHARED TARGET")
for path in files:
    rel = os.path.relpath(path, SRC)
    text = io.open(path, encoding="utf-8").read()
    for m in re.finditer(r"(document|window|ownerDocument)\.addEventListener\(\s*[\"'](\w+)", text):
        line = text[: m.start()].count("\n") + 1
        removed = ("removeEventListener" in text) or ("registerDomEvent" in text)
        print("  %-28s %-9s line %-4d %s" % (rel, m.group(2), line,
                                             "cleaned up" if removed else "NO REMOVAL"))

# What can only fail in use.
print("\nPATHS THAT CAN ONLY FAIL WHEN USED")
probes = {
    "presenter window": r"openPopoutLeaf",
    "Excalidraw drawing": r"createSVG",
    "vault graph view": r'type: "graph"',
    "card script": r"new Function",
    "minutes written": r"vault\.create\(",
    "export written": r"vault\.create\(",
    "sub-deck": r"enterSubdeck",
    "image embeds": r"internal-embed",
    "canvas selection": r"getSelectionData",
    "hotkey display": r"hotkeyManager",
}
blob = "".join(io.open(p, encoding="utf-8").read() for p in files)
for name, pattern in probes.items():
    hit = "present" if re.search(pattern, blob) else "MISSING"
    print("  %-22s %s" % (name, hit))
