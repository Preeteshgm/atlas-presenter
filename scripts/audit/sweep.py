"""
The same class of check, across the whole project.

Each one is a bug we have actually hit: an event escaping to the app behind the
deck, a listener or loop nobody stops, a class the code emits with no rule, an
await that was dropped, a promise nobody catches.
"""
import io
import os
import re

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

ROOT = ROOT
SRC = os.path.join(ROOT, "src")

findings = []
notes = []


def read(p):
    return io.open(p, encoding="utf-8").read()


def files(ext=".ts"):
    for dirpath, dirnames, names in os.walk(SRC):
        dirnames[:] = [d for d in dirnames if d != "node_modules"]
        for n in names:
            if n.endswith(ext):
                yield os.path.join(dirpath, n)


src = {os.path.relpath(p, ROOT): read(p) for p in files()}
css = read(os.path.join(ROOT, "styles.css"))

# 1 ── every addEventListener on a shared target should have a matching removal
SHARED = ("document.addEventListener", "window.addEventListener")
for rel, body in src.items():
    for target in SHARED:
        for m in re.finditer(re.escape(target) + r'\("(\w+)"', body):
            evt = m.group(1)
            remover = target.replace("add", "remove")
            if remover not in body or evt not in body.split(remover, 1)[1][:200]:
                findings.append("%s: %s(\"%s\") with no matching removal" % (rel, target, evt))

# 2 ── anything that starts a loop or timer must be stoppable
for rel, body in src.items():
    if "requestAnimationFrame" in body and "cancelAnimationFrame" not in body:
        findings.append("%s: requestAnimationFrame with no cancel" % rel)
    if "setInterval" in body and "clearInterval" not in body:
        findings.append("%s: setInterval with no clear" % rel)
    if "setTimeout" in body and "clearTimeout" not in body:
        notes.append("%s: setTimeout without clearTimeout (fine if one-shot)" % rel)

# 3 ── classes the code emits, and the rules that should exist for them
emitted = set()
for body in src.values():
    emitted |= set(re.findall(r'cls: "(atl-[\w-]+)"', body))
    emitted |= set(re.findall(r'addClass\("(atl-[\w-]+)"\)', body))
    emitted |= set(re.findall(r'classList\.add\("(atl-[\w-]+)"\)', body))
shadow_css = "".join(src.values())
for cls in sorted(emitted):
    if ("." + cls) not in css and ("." + cls) not in shadow_css:
        findings.append("css: no rule for .%s" % cls)

# 4 ── a promise-returning call used as a statement, unawaited and uncaught
for rel, body in src.items():
    for m in re.finditer(r"^\s+(this\.\w+\([^;]*\));\s*$", body, re.M):
        call = m.group(1)
        name = re.match(r"this\.(\w+)", call).group(1)
        if re.search(r"(private |public )?async %s\(" % re.escape(name), body) and "void " not in call:
            findings.append("%s: async %s() called without await or void" % (rel, name))

# 5 ── settings read at runtime but never offered in the UI, and vice versa
types = read(os.path.join(ROOT, "src", "types.ts"))
block = types[types.index("export interface AtlasSettings") if "AtlasSettings" in types
              else types.index("export interface CartographSettings"):]
keys = re.findall(r"^\t([a-zA-Z]+):", block[: block.index("\n}")], re.M)
runtime = "".join(v for k, v in src.items() if "settings.ts" not in k)
ui = src["src\\settings.ts"]
for k in keys:
    if not re.search(r"\b(settings|s)\.%s\b" % k, runtime):
        findings.append("settings: %s is never read at runtime" % k)
    if not re.search(r"\bs\.%s\b" % k, ui):
        findings.append("settings: %s has no control in the UI" % k)

# 6 ── shadow-root cards need their own copy of any rule they use
shadow = src["src\\present\\render.ts"]
# The reset used to be assigned to a style element's textContent; it is a
# constant adopted as a stylesheet now. Anchored on the constant, which is the
# thing that actually holds the rules.
shadow_block = shadow[shadow.index("const RESET ="): shadow.index("const win =")]
for cls in ("atl-step", "atl-frame-item", "atl-slideshow", "atl-gallery", "atl-scroll",
            "atl-show-controls", "atl-show-arrow", "atl-show-dot"):
    if "." + cls not in shadow_block:
        notes.append("shadow css: .%s has no rule inside a shadow root" % cls)

print("CHECKED: listener removal, loops and timers, emitted classes, dropped awaits,")
print("         settings wiring, shadow-root coverage\n")
if findings:
    print("FINDINGS")
    for f in findings:
        print("  !", f)
else:
    print("No findings.")
if notes:
    print("\nWORTH A LOOK")
    for n in notes:
        print("  ~", n)
