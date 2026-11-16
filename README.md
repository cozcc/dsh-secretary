# dsh-secretary

**Your DSH secretary** — a sticky-note canvas plus scheduled briefings that tell you what every DeepSeek Harness thread is doing, what still needs you, and what it costs.

> This is a **DSH plugin**, not a standalone application. It runs inside DeepSeek Harness: the UI is a panel in the DSH sidebar, the service is a route on DSH's own web server, and there is no separate process or port.

---

## What it does

### 1. A canvas you can write on
- Double-click the canvas to add a note; press `＋` (bottom-right) to add one at the leftmost free slot — newer notes always sit further left, older ones shift right
- Tick the circle to finish a note (strikethrough + dimmed card); tick again to undo
- Log progress on unfinished notes; drag cards; drop on the trash can to delete
- Cards grow with their content — no inner scrollbars
- Long text is stored **verbatim**: exceeding a very high limit returns an explicit error instead of silently trimming
- Each card keeps a **change history** (created / text / progress / done / cancelled, last 100) and can be **exported as Markdown** with that history
- Layout is packed by **measured card height**; rows wrap at the **visible right edge** (no horizontal scrolling), newest card top-left
- Default order puts **unfinished cards first**, then completed, then abandoned; inside a group the newest comes first
- `自动排列` re-applies that order: left → right, wrap, then next row
- Unified Apple-Notes-style palette and toolbar: white cards on a light canvas, one accent colour, 30px toolbar buttons

### 2. Session cards pulled from DSH threads
- `拉取线程任务` scans **every workspace** and turns each thread's last `todo_write` list into a card
- Unfinished todos are **clickable**: jump straight to that thread (`uiWorkspace.openSession`)
- Each card has three actions:
  - **继续** — copies a *resume draft* (goal / unfinished todos / recent progress / deliverables) to the clipboard and opens the thread
  - **刷新** — re-pull only this thread
  - **取消** — abandon the task: excluded from "open", never resurrected by later pulls, restorable anytime
- Deduplicated by source session; cards you edited are never overwritten (system fields such as goal/deliverables are still back-filled)
- **One card per thread**: when a thread moves on to a new task, the card follows the thread's new title and keeps every earlier task stage — the badge reads `第 N 个任务`, and the history panel lists each stage's checklist. Your own renames are never overwritten

### 3. Briefings
- `生成简报` produces a briefing card on the canvas: last 24h overview, **needs your attention**, in progress, completed, token cost, long-term totals
- Runs automatically at a configurable local time (default **08:00**), and catches up at startup if today's briefing is missing
- Snapshots live in `briefs/YYYY-MM-DD.json`, pruned after 90 days (configurable)

### 4. Long-term totals that never expire
- `cumulative.json` keeps a per-session, per-day ledger forever (brief snapshots are pruned, this is not)
- Idempotent: re-reading a thread replaces its bucket instead of adding again
- Shown in the top bar (`累计 2.86B tokens`) and as a section in every briefing

### 5. Real-time review badges
- When a thread finishes a turn (`turn/end` with `completed`), its card is flagged **待验收** immediately — no scan required
- Click the badge to accept it (same as ticking the note)

---

## Install

### Option A — from this repository (DSH plugin page)
1. Open DSH → **Plugins → Add plugin**
2. Paste this repository URL (or a local clone path) and install
3. Enable it, then reload DSH

### Option B — local directory
```bash
git clone https://github.com/cozcc/dsh-secretary.git
```
Then in DSH: **Plugins → Add plugin** and pick the cloned directory.

### Option C — npm (once published)
```
dsh-secretary@0.1.0
```

After installing, open **DSH 助理** from the left sidebar.

---

## Where data lives

```
~/.dsh/secretary/
  board.json            canvas (notes, brief cards, review flags)
  cumulative.json       lifetime token/cost ledger (never pruned)
  session-digests.json  per-session digest cache, keyed by size:mtime signature
  briefs/YYYY-MM-DD.json daily briefing snapshots (pruned after N days)
  settings.json         daily time, retention, enable switch
  api-token             fallback token (owner identity is preferred)
```

**Read-only by design.** Session logs are only read:

- `~/.dsh/sessions/<project>/<session>/session.v4.jsonl.zstd` — multi-frame zstd, decoded frame by frame, tolerant of corrupt lines, incremental by `size:mtime`
- `~/.dsh/storages/workspace.json` — session → workspace mapping
- `~/.dsh/storages/session_projcache/sessions/<id>.json` — DSH Session Goal (authoritative "task objective")

## Auth

Every route (including reads) requires **either** a DSH `owner` identity via `connection.admit()` **or** the local fallback token. Anything else is `403`. Admission is fail-closed: an exception or an unexpected shape is a rejection.

## Configuration

In-app: top bar **设置** → daily time, snapshot retention, auto-brief on/off.

Profile-level (`cordis.patch.yml`):
```yaml
- insert:
    - id: secretary
      name: dsh-secretary
      config:
        dataDir: ""
```

## Development

```bash
node build-client.mjs      # regenerate lib/client.js + lib/index.js
node --test test/*.test.mjs
```

- The browser half must stay a plain IIFE (no `import`/`export`), because DSH injects it as raw script text
- The host half is bundled into a single `lib/index.js`; if you add a Node built-in import, add it to the import list in `build-client.mjs`
- Panel regression (headless React + jsdom) is `test/panel.render.mjs`; it needs `react`, `react-dom`, `jsdom` installed in a scratch directory:

```bash
mkdir -p /tmp/wb-run && cd /tmp/wb-run && npm i react@19 react-dom@19 jsdom@25
cp ~/dsh-secretary/test/panel.render.mjs ./probe.mjs
WB_BUNDLE=~/dsh-secretary/lib/client.js node probe.mjs
```

## Limitations

- **UI text is Chinese only** for now (English strings live in `locale/en.json` for metadata; PRs welcome)
- This DSH version exposes **no API to put text into the composer**, so "继续" uses the clipboard (with a manual-copy fallback dialog)
- Sessions without a `todo_write` list produce no card
- Cost is an estimate for unknown model ids (priced as flash and flagged)
- "Needs attention" is windowed: stalled 3–14 days, turn errors within 2 days — older threads stay quiet on purpose

## License

MIT © 2026 cozcc
