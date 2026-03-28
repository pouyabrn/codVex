# codVex

I built `codVex` so I can keep using my Codex/Cursor chat from my phone when I am away from my desk.

It runs a local bridge, starts a Codex `app-server`, and exposes a browser-safe UI. From phone, I can:

- list recent Codex threads for the current repo
- open the current thread
- read the saved conversation
- send new prompts into that thread
- handle approval and user-input requests

## Why I made this

Codex `app-server` is great locally, but browser clients cannot connect to it directly because websocket `Origin` headers get rejected. This sits in the middle and fixes that:

`phone browser -> codVex bridge -> local codex app-server`

## Run

```bash
npm install
npm start
```

Default address is `http://127.0.0.1:3010`.

Useful env vars:

- `HOST`: bridge bind address (default `127.0.0.1`)
- `PORT`: bridge port (default `3010`)
- `CODEX_THREAD_CWD`: repo path used when listing threads (default current working directory)
- `CODEX_BIN`: explicit path to the Codex binary if auto-detection fails
- `THREAD_SYNC_INTERVAL_MS`: refresh interval for syncing the selected thread from disk

## Phone access

Safest option is keeping it on `127.0.0.1` and exposing it with Tailscale Serve or an SSH tunnel, instead of opening the raw port to the internet.

## Current limits

- Phone UI streams live output for prompts sent through this bridge
- Prompts sent from the original Cursor/Codex session on PC are picked up by periodic thread refresh
- This is chat-first on purpose: conversation + approvals, not a full IDE
