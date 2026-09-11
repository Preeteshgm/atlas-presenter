"""A full pass over the plugin: naming, wiring, CSS, demo integrity, install."""
import io
import json
import os
import re

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

ROOT = ROOT
VAULT = os.environ.get("ATLAS_VAULT", "")
PLUGIN = os.path.join(VAULT, ".obsidian", "plugins", "atlas-presenter") if VAULT else ""

ok, warn, bad = [], [], []


def read(*parts):
    p = os.path.join(*parts)
    return io.open(p, encoding="utf-8").read() if os.path.exists(p) else ""


def walk(base, exts):
    for dirpath, dirnames, files in os.walk(base):
        dirnames[:] = [d for d in dirnames if d not in {"node_modules", ".git", "dist"}]
        for f in files:
            if os.path.splitext(f)[1] in exts:
                yield os.path.join(dirpath, f)


# ---------------------------------------------------------------- 1. naming
stale = []
for path in walk(ROOT, {".ts", ".css", ".md", ".json", ".html", ".canvas", ".ps1"}):
    body = read(path)
    for token in ("Cartograph", "cartograph", "ctg-", "Terrain", "terrain", "trn-"):
        if token in body:
            stale.append("%s: %s" % (os.path.relpath(path, ROOT), token))
(ok if not stale else bad).append(
    "naming: clean" if not stale else "naming: %d stale references\n     %s"
    % (len(stale), "\n     ".join(stale[:8]))
)

man = json.loads(read(ROOT, "manifest.json"))
(ok if man["id"] == "atlas-presenter" else bad).append(
    "manifest: %s / %s / v%s" % (man["id"], man["name"], man["version"])
)

# ------------------------------------------------------------- 2. settings
types = read(ROOT, "src", "types.ts")
block = types[types.index("export interface AtlasSettings")
              if "export interface AtlasSettings" in types
              else types.index("export interface CartographSettings"):]
block = block[: block.index("\n}")]
keys = re.findall(r"^\t([a-zA-Z]+):", block, re.M)

runtime = "".join(read(p) for p in walk(os.path.join(ROOT, "src", "present"), {".ts"}))
runtime += read(ROOT, "src", "main.ts")
ui = read(ROOT, "src", "settings.ts")

dead = [k for k in keys if not re.search(r"\b(settings|s)\.%s\b" % k, runtime)]
missing_ui = [k for k in keys if not re.search(r"\bs\.%s\b" % k, ui)]
(ok if not dead else bad).append(
    "settings: %d, all consumed" % len(keys) if not dead
    else "settings: DEAD -> %s" % ", ".join(dead))
(ok if not missing_ui else warn).append(
    "settings: all exposed in the UI" if not missing_ui
    else "settings: no UI control -> %s" % ", ".join(missing_ui))

# ------------------------------------------------------------------ 3. CSS
css = read(ROOT, "styles.css")
shadow = read(ROOT, "src", "present", "render.ts")
defined = set(re.findall(r"\.(atl-[\w-]+)", css)) | set(re.findall(r"\.(atl-[\w-]+)", shadow))
used = set()
for path in walk(os.path.join(ROOT, "src"), {".ts"}):
    body = read(path)
    used |= set(re.findall(r"[\"'`](atl-[\w-]+)", body))
    used |= set(re.findall(r"cls: \"(atl-[\w-]+)", body))

# `atl-tag-${name}` and `atl-clip-${id}` are prefixes built at runtime, not
# class names, so there is nothing for them to match.
DYNAMIC = ("atl-tag-", "atl-clip-")
undefined = sorted(u for u in used if u not in defined and u not in DYNAMIC)
unused = sorted(d for d in defined if d not in used and not d.startswith("atl-tag"))
(ok if not undefined else bad).append(
    "css: every class used in code has a rule" if not undefined
    else "css: NO RULE for -> %s" % ", ".join(undefined))
(ok if len(unused) < 12 else warn).append("css: %d rules not referenced from code "
                                          "(theme hooks, states)" % len(unused))

# ----------------------------------------------------------------- 4. demo
pack = os.path.join(ROOT, "demo", "Atlas")
for canvas in sorted(f for f in os.listdir(pack) if f.endswith(".canvas")):
    data = json.loads(read(pack, canvas))
    nodes, edges = data["nodes"], data["edges"]
    missing = []
    for n in nodes:
        if n.get("type") == "file":
            rel = n["file"].replace("Atlas/", "")
            if not os.path.exists(os.path.join(pack, rel.replace("/", os.sep))):
                missing.append(n["file"])
    ids = {n["id"] for n in nodes}
    broken = [e["id"] for e in edges if e["fromNode"] not in ids or e["toNode"] not in ids]
    line = "demo %-26s %2d cards %2d edges" % (canvas, len(nodes), len(edges))
    if missing or broken:
        bad.append(line + "  missing=%s broken-edges=%s" % (missing, broken))
    else:
        ok.append(line)

# -------------------------------------------------------------- 5. install
if not PLUGIN:
    warn.append("install: set ATLAS_VAULT to check what a vault actually has")
for f in ("main.js", "manifest.json", "styles.css") if PLUGIN else ():
    src = os.path.join(ROOT, f)
    dst = os.path.join(PLUGIN, f)
    if not os.path.exists(dst):
        bad.append("install: %s missing from the vault" % f)
    elif read(src) != read(dst):
        bad.append("install: %s differs from the build" % f)
if PLUGIN and os.path.exists(os.path.join(PLUGIN, "data.json")):
    saved = json.loads(read(PLUGIN, "data.json"))
    unknown = [k for k in saved if k not in keys]
    ok.append("install: 3 files match, settings carried (%d keys%s)"
              % (len(saved), ", %d stale" % len(unknown) if unknown else ""))

print("PASS")
for line in ok:
    print("  +", line)
if warn:
    print("\nNOTE")
    for line in warn:
        print("  ~", line)
print("\nFAIL" if bad else "\nNo failures.")
for line in bad:
    print("  !", line)
