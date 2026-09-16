# Running a local model

Atlas can answer questions from your own notes. That needs a model, and **no
model ships with the plugin** — they are gigabytes, they are not ours to
distribute, and a plugin has no business putting binaries on your machine.

So Atlas is a thin client: you run a server, Atlas talks to it over
`127.0.0.1`. Until you set one up the feature is invisible — no ribbon icon,
no button on the presenting bar, and no network call of any kind. Everything
else works exactly the same without it.

---

## The short version

```
1.  Install Ollama            https://ollama.com/download
2.  ollama pull qwen2.5:3b
3.  Settings → Atlas Presenter → Asking your notes → Find
```

**Find** looks for a server on the ports Ollama and llama-server use and fills
in whichever answers, naming the models it found. **Test** says exactly what is
wrong if something is not right: not answering, no models pulled, or connected.

---

## If you already have a .gguf on disk

llama.cpp's `llama-server` points straight at a file, with nothing to download.
Take the CPU build from
[llama.cpp releases](https://github.com/ggml-org/llama.cpp/releases) — the
`bin-win-cpu-x64` zip is about 18 MB and needs no installer.

```
llama-server -m path\to\model.gguf --host 127.0.0.1 --port 8080 -c 16384 -t 4
```

Then **Find**, or type `http://127.0.0.1:8080` yourself.

`-c` is the context window. 4096 is tight once a few notes are in the prompt;
16384 costs only memory.

---

## Which model

`qwen2.5:3b` is a good starting point — about 2 GB on disk, 3–4 GB of RAM while
it answers, and two to three seconds a question on a normal processor. Move to
`qwen2.5:7b` if the answers feel thin. Changing it is one field in settings, so
it is worth trying a larger one before concluding something cannot be done.

---

## Does an update overwrite my setup?

**No.** Updating Atlas — from the community store or by hand — replaces three
files:

```
main.js   manifest.json   styles.css
```

Your settings live in `data.json`, in the same folder, and are **never
touched**. Neither is anything outside the vault: your server, your model
files, and any shortcut that starts them are untouched by an Obsidian update.

So after an update the ask panel keeps working, pointed at the same server as
before. The only thing that stops it working is the **server** not running —
which has nothing to do with the plugin version.

### If the ask controls disappear after an update

They appear only when a model is configured, so their absence means Atlas can
no longer see one. In order of likelihood:

1. **The server is not running.** Start it, then reopen settings and press
   **Test**.
2. **The address moved.** Press **Find**.
3. **`data.json` was lost** — a new vault, or settings cleared. Set the address
   again; nothing else needs restoring.

### Keeping the server running

A server started from a terminal dies with the terminal. To have one at hand
whenever Obsidian is open, put a shortcut to a start script in your Startup
folder:

```
%APPDATA%\Microsoft\Windows\Start Menu\Programs\Startup
```

Ollama installs its own background service and needs none of this.

---

## Nothing leaves your machine

The address field **refuses anything that is not local** — `127.0.0.1`,
`localhost` or `[::1]`. Paste a cloud endpoint and you get a notice, not a saved
setting.

There is a separate, explicitly-labelled option to use OpenAI, which is off by
default, needs a key you enter yourself, and states on every answer that the
notes were sent. That is a decision to make on purpose, never a fallback that
happens quietly because a local server was down.
