# Audits

Four sweeps, each written after a real bug got through review.

| | Looks for |
|---|---|
| `leaks.py` | A listener that acts on an event and then lets it travel on — which is how arrow keys ended up moving cards in the canvas behind a deck |
| `sweep.py` | Listeners never removed, loops never stopped, `async` called without `await`, classes the code emits with no CSS rule |
| `audit.py` | Stale names, settings declared but never read or never exposed, demo integrity, install drift |
| `demo_audit.py` | Whether every feature still has an example in the demo decks |

```bash
python scripts/audit/leaks.py
python scripts/audit/sweep.py
python scripts/audit/demo_audit.py
ATLAS_VAULT="/path/to/vault" python scripts/audit/audit.py   # install drift needs a vault
```

Two findings are expected from `audit.py`: `atl-clip-` and `atl-tag-` are
dynamic prefixes (`atl-tag-${name}`), not class names, so there is nothing to
define.

None of these can tell you whether an interaction is *right* — only that the
plumbing holds. Every wrong interaction so far was found by presenting.
