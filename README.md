# codVex

`codVex` lets you keep your Codex/Cursor chat going from your phone.

It runs a local bridge, starts Codex `app-server`, and serves a phone-safe UI.

Phone UI can:

- list recent Codex threads for the selected repo
- open and read a thread
- send new prompts to that same thread
- handle approvals and user-input requests

## Why This Exists

Browser clients cannot connect directly to Codex `app-server` because websocket `Origin` checks fail.

`codVex` solves this:

`phone browser -> codVex bridge -> local codex app-server`

## Full Guide (New One-Command Workflow)

### 1) One-time setup

From `codVex` directory:

```bash
npm install
npm run install:command
```

If your shell does not find `codvex`, add this once to `~/.bashrc`:

```bash
export PATH="$HOME/.local/bin:$PATH"
```

Then restart terminal or run:

```bash
source ~/.bashrc
```

### 2) Daily use in any project

Open terminal in your target project, then run:

```bash
codvex
```

This defaults to:

- project directory: current directory (`$PWD`)
- port: `3011`
- `tailscale serve` enabled

The script prints your phone URL. Open that URL on phone.

### 3) Command forms

```bash
codvex                       # current project, port 3011
codvex 3020                  # current project, custom port
codvex /path/to/project      # explicit project, port 3011
codvex /path/to/project 3020 # explicit project + port
```

### 4) What launcher does

`run-codvex.sh`:

- sets `CODEX_THREAD_CWD` to target repo
- starts Codex bridge on selected port
- tries to install Tailscale on Linux if missing
- runs `tailscale serve --bg <port>`
- prints the phone URL to open
- if launched with `sudo`, starts Codex bridge back as your normal user (fixes Codex binary lookup)

## Launcher Options

Environment variables:

- `HOST`: bind address (default `127.0.0.1`)
- `ENABLE_TAILSCALE_SERVE=0`: skip `tailscale serve`
- `AUTO_INSTALL_TAILSCALE=0`: skip Tailscale auto-install
- `CODEX_BIN`: explicit Codex binary path
- `THREAD_SYNC_INTERVAL_MS`: thread refresh interval

## First-Time Repo Note

If phone UI shows no threads for a repo, this is normal when that repo has no Codex history yet.

Create one thread from desktop first:

1. Open the repo in Cursor/Codex.
2. Send one message.
3. Refresh phone page.

## Troubleshooting

### `EADDRINUSE` on port

Another process already uses that port.

Use a different port:

```bash
codvex 3020
```

### `Could not find the Codex binary`

Usually caused by running everything as root.

Use:

```bash
sudo /path/to/run-codvex.sh /path/to/project 3011
```

The script now starts Codex as your normal user automatically.

### Tailscale says access denied for `serve`

Run once:

```bash
sudo tailscale set --operator=$USER
```

Then retry `codvex`.

## Security

- Keep CodVex bound to `127.0.0.1`.
- Use Tailscale Serve or SSH tunnel for phone access.
- Do not expose raw local port directly to the internet.

## Legacy Manual Run

```bash
npm start
```

Default address:

`http://127.0.0.1:3010`

## Current Limits

- phone UI streams live output for prompts sent through bridge
- prompts sent from desktop Codex session are picked up via periodic refresh
- chat-first workflow, not full IDE replacement
