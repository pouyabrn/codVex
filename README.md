# codVex

I made `codVex` because I wanted to keep my Codex/Cursor chat going from my phone when I am away from my desk.

This project runs a local bridge, starts a Codex `app-server`, and serves a browser-safe UI.
From phone, I can:

- see recent Codex threads for the current repo
- open the current thread
- read the stored conversation
- send new prompts into that same thread
- handle approvals and user-input requests

## Why this exists

Codex `app-server` works great locally, but browser clients cannot connect to it directly because websocket `Origin` headers are rejected.
`codVex` sits in the middle and makes this work:

`phone browser -> codVex bridge -> local codex app-server`

## Run

```bash
npm install
npm start
```

Default address:

`http://127.0.0.1:3010`

Useful env vars:

- `HOST`: bridge bind address (default `127.0.0.1`)
- `PORT`: bridge port (default `3010`)
- `CODEX_THREAD_CWD`: repo path used when listing threads (default: current working directory)
- `CODEX_BIN`: explicit path to Codex binary if auto-detection fails
- `THREAD_SYNC_INTERVAL_MS`: how often the selected thread is refreshed from disk

## Phone Access

Best setup is to keep this on `127.0.0.1` and expose it using Tailscale Serve or an SSH tunnel.
Do not open the raw port directly to the internet.

## Current Limits

- Phone UI streams live output for prompts sent through this bridge
- Prompts sent from the original Cursor/Codex session on PC are picked up by periodic refresh
- This is intentionally chat-first (conversation + approvals), not a full IDE replacement
