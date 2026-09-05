# MySsh

A MobaXterm-style desktop SSH/SFTP client for macOS / Windows / Linux, built with
**Tauri 2 + russh + russh-sftp + xterm.js + Monaco Editor**.

![stack](https://img.shields.io/badge/Tauri-2.x-blue) ![rust](https://img.shields.io/badge/russh-0.63-orange)

## Features

### Session management (persisted)
- Home screen lists all saved sessions as cards (search, connect, edit, delete)
- Sessions are stored in the OS config dir:
  - macOS: `~/Library/Application Support/com.ssh.client/sessions.json`
  - Linux: `~/.config/com.ssh.client/sessions.json`
  - Windows: `%APPDATA%\com.ssh.client\sessions.json`
- Auth methods: **password**, **private key** (with optional passphrase), or **auto** (key → password fallback)
- Optional "skip host key check" per session — accepts any server key without
  consulting `~/.ssh/known_hosts` (handy for test environments / rotated keys;
  the UI shows a warning when enabled)
- Optional "remember password" (stored in the session file — see security note below)
- The workspace stays alive when you go back to the session list; return via the
  "back to workspace" button without reconnecting

### Terminal (interactive PTY)
- Real PTY via russh (`request_pty` + `request_shell`), xterm-256color
- Live resize (window changes propagate as `window-change` requests)
- Multiple shell tabs per connection
- Trust-on-first-use host key verification against `~/.ssh/known_hosts`;
  changed keys are rejected with a clear error

### SFTP file browser
- Right-hand panel with breadcrumbs, sortable listing (name/size/mtime/perms)
- Multi-select (⌘/Ctrl click, Shift click), context menu
- Create folder / create file / rename / delete (recursive) / copy path
- **Parallel transfers** — up to **10 files** concurrently, each streamed in 256 KB
  chunks with throttled progress events; per-batch cancel
- Drag & drop files anywhere on the window to upload to the current directory
- Recursive uploads (folders are walked locally, remote dirs auto-created)

### Preview
- Text & code files up to 1 MB with syntax highlighting (Monaco, read-only)
- Images (png/jpg/gif/webp/bmp/svg) up to 30 MB
- Archives: `zip` / `tar` / `tar.gz` up to 512 MB — entry list plus in-place
  viewing of text entries (≤ 2 MB); archive download is cached per session
- Binary files are detected and refused with a hint to download instead

### Editor
- Open any text file ≤ 5 MB in Monaco with language auto-detection
- `⌘S` / `Ctrl+S` or the Save button writes back to the server
- Unsaved-changes guard on close

## Development

```bash
npm install        # frontend deps
npm run tauri dev  # runs vite + cargo, opens the app
```

Requirements: Node 18+, Rust 1.77+ (stable), and the usual
[Tauri 2 prerequisites](https://tauri.app/start/prerequisites/).

## Production build

```bash
npm run tauri build
```

Artifacts land in `src-tauri/target/release/bundle/`.

## Architecture

```
src-tauri/src/
  main.rs             Tauri commands (SSH/PTY/SFTP/preview/edit/transfers/sessions)
  ssh_session.rs      connect + auth + known_hosts + PTY event loop
  ssh_sftp.rs         list/mkdir/touch/rename/delete helpers
  ssh_sftp_parallel.rs semaphore-bounded transfer engine with progress events
  ssh_preview.rs      file-type detection, archive cache, entry extraction
  ssh_edit.rs         read/save for the editor (binary & size guards)
  sessions.rs         persisted session list (atomic JSON writes)
  state.rs            connection & transfer registries

src/
  App.tsx             home ↔ workspace views, event routing, drag & drop
  components/         SessionManager, SessionFormModal, TerminalPanel,
                      SftpPanel, TransferPanel, FilePreviewModal, FileEditorModal
  services/ipc.ts     typed wrappers over every Tauri command
  monaco.ts           local Monaco bundling (no CDN)
```

Events: `pty-output` (base64 chunks), `pty-exit`, `transfer-progress`,
`transfer-finished`.

## Security notes

- Host keys follow OpenSSH TOFU semantics; mismatches abort the connection
  unless "skip host key check" is enabled for that session.
- Passwords are only stored when "remember" is opted into, and live in plain text
  inside `sessions.json` — disk encryption (FileVault/BitLocker) is recommended,
  or leave the box unchecked and type the password each time.
- Preview and editor size caps protect against accidentally loading huge files.
