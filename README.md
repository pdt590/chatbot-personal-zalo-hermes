<p align="center">
  <img src="https://raw.githubusercontent.com/cuongdev/hermes-zalo-plugin/main/assets/logo.svg" alt="hermes-zalo-plugin" width="660">
</p>

# hermes-zalo-plugin

📖 **English** · [Tiếng Việt](./README.vi.md)

[![npm version](https://img.shields.io/npm/v/hermes-zalo-plugin.svg)](https://www.npmjs.com/package/hermes-zalo-plugin)
[![license](https://img.shields.io/npm/l/hermes-zalo-plugin.svg)](./LICENSE)

Chat with your **Hermes Agent** from a **personal Zalo account**: private chats
and groups, with images, files, voice, stickers and reactions. Runs on macOS,
Linux and Windows.

> ⚠️ Built on [zca-js](https://www.npmjs.com/package/zca-js), an **unofficial**
> Zalo API. Zalo may rate-limit or lock automated accounts. Use a secondary account.

## Contents

1. [Install](#install)
2. [How it works](#how-it-works)
3. [Usage](#usage)
4. [Configuration](#configuration)
5. [Security](#security)
6. [HTTP API](#http-api)
7. [Update & uninstall](#update--uninstall)
8. [Troubleshooting](#troubleshooting)
9. [Development](#development)

## Install

**Requirements:** Node.js ≥ 18, Hermes Agent (`pip install aiohttp`), and the Zalo
phone app to scan a QR code.

```bash
# 1. Get the code. Keep the folder: the background service runs from it.
git clone https://github.com/pdt590/chatbot-personal-zalo-hermes.git hermes-zalo-plugin
cd hermes-zalo-plugin

# 2. Install: dependencies, QR login, background service, Hermes adapter.
./install.sh                    # Windows: .\install.ps1

# 3. Connect to Hermes.
hermes gateway setup            # choose "Zalo": allowed users, groups, permissions
hermes gateway                  # start chatting
```

On Windows, if PowerShell blocks the script, run
`Set-ExecutionPolicy -Scope Process -ExecutionPolicy Bypass` first.

The installer is safe to re-run: it skips the QR scan while the session is valid
and restarts the service on the new code.

| Flag                   | Effect                                                                                                 |
| ---------------------- | ------------------------------------------------------------------------------------------------------ |
| `--relogin`            | Force a new QR scan.                                                                                   |
| `--service-only`       | Only (re)install the service and the adapter.                                                          |
| `--no-service`         | Skip the service; run the bridge yourself with `node bin/cli.mjs start`.                               |
| `--hermes-home <path>` | Install the adapter into this Hermes profile (same as `HERMES_HOME`). Default: `~/.hermes` if it exists. |
| `--with-hook`          | Also install the [tool access hook](#tool-access-hook-optional). Once installed, re-runs keep it updated. |
| `--hook-owner <uid>`   | Install the hook and set `ZALO_HOOK_OWNERS` (comma-separated uids) in the profile `.env`.               |
| `--hook-mode <mode>`   | Install the hook and set `ZALO_HOOK_OWNER_MODE`: `read` · `full-dm` · `full`.                           |

## How it works

```mermaid
flowchart LR
  Z[Zalo servers] <-- "WebSocket in<br/>HTTPS out" --> B["Bridge (Node + zca-js)<br/>background service"]
  B -- "SSE  GET /events" --> A["Hermes adapter (Python)<br/>~/.hermes/plugins/zalo"]
  A -- "REST  POST /send, /api/…" --> B
  A <--> H[Hermes gateway + agent]
```

| Part                                      | Runs as                                                                                  | Job                                                                                                                                  |
| ----------------------------------------- | ---------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| **Bridge** (`server.js`, `zaloClient.js`) | systemd user unit (Linux), launchd agent (macOS), Scheduled Task at logon (Windows)       | Keeps the Zalo session alive, streams inbound events over SSE, exposes REST routes for every zca-js method behind an action policy. |
| **Adapter** (`hermes-plugin/`)            | Plugin `zalo-platform` inside `hermes gateway`                                           | Turns events into Hermes messages, downloads media, decides which chats to answer, sends replies through the bridge.               |

Data lives in `~/.hermes-zalo/` (override with `ZALO_DATA_DIR`): `credentials.json`,
`bridge.env`, `qr.png`, the undo cache and logs. Updates and reinstalls keep it.

### Commands

`node bin/cli.mjs <command>` (shown as `hermes-zalo-plugin <command>` in tool output
and when installed from npm):

| Command           | What it does                                                         |
| ----------------- | -------------------------------------------------------------------- |
| `status`          | Service state, bridge health, logged-in account, data paths.         |
| `login [--force]` | QR login. A running bridge picks up the new session by itself.       |
| `restart`         | Restart (or start) the service. Needed after editing `bridge.env`.   |
| `stop`            | Stop the service; it stays installed.                                |
| `start`           | Run the bridge in the foreground.                                    |

## Usage

<p align="center">
  <img src="https://raw.githubusercontent.com/cuongdev/hermes-zalo-plugin/main/assets/zalo-chat.svg" alt="Chatting with the Hermes agent from Zalo" width="300">
</p>

- **Private chat:** message the bot's Zalo account.
- **Groups:** by default (`ZALO_GROUP_MODE=mention`) the bot answers only when
  @mentioned, replied to, or when a message starts with its display name. With no
  group selected in the wizard, it stays out of all groups.
- **Group stats & summaries:** add `zalo_groups` under `platform_toolsets.zalo` in
  `config.yaml` to give the agent `zalo_group_stats` and `zalo_group_messages`. Only
  messages received while the bridge was running are available
  (`ZALO_GROUP_LOG_DAYS`).
- **Finding IDs:** set `ZALO_LOG_IDS=true`, send a message, read the
  `uid=… threadId=…` line in the gateway log. `hermes gateway setup` searches
  contacts by name, so you rarely need raw IDs.

### Message formatting

The agent writes Markdown; the bridge converts it to Zalo text styles.

| Markdown                                         | Zalo                                  |
| ------------------------------------------------ | ------------------------------------- |
| `**bold**`, `*italic*`, `***both***`, `~~strike~~` | matching style                      |
| `` `code` ``                                     | bold (no monospace in Zalo)           |
| `# Heading` (any level)                          | bold + large                          |
| `> quote`                                        | italic                                |
| `1. item`                                        | number in bold + large                |
| `- item`, nested items                           | `- item`, nested become `• item`      |
| `[label](https://…)`                             | **label** (https://…)                 |
| `[red]…[/red]`, `[orange]`, `[yellow]`, `[green]` | colored text (aliases: `do`, `cam`, `vang`, `xanh`) |

Markers must touch the words they wrap (`2 * 3`, `snake_case` stay as-is) and never
cross a line break. Code fences are stripped, `---` is dropped, tables arrive as
plain text. Long replies are split at paragraph/line breaks to fit Zalo's limits
(2000 characters, 40 styles).

## Configuration

`hermes gateway setup` writes both files below.

**Adapter:** the Hermes profile's `.env`. Restart `hermes gateway` after editing.

| Var                    | Default     | Meaning                                                                                              |
| ---------------------- | ----------- | ---------------------------------------------------------------------------------------------------- |
| `ZALO_PLUGIN_URL`      | required    | Bridge address, e.g. `http://127.0.0.1:8787`.                                                        |
| `ZALO_PLUGIN_TOKEN`    | —           | Must match the bridge token, if set.                                                                 |
| `ZALO_ALLOWED_USERS`   | empty       | Comma-separated uids allowed to use the bot.                                                         |
| `ZALO_ALLOW_ALL_USERS` | `false`     | `true` lets anyone talk to the bot. Otherwise unknown senders must pair or be allowlisted.           |
| `ZALO_ALLOWED_THREADS` | empty = all | Comma-separated group/chat IDs the bot works in.                                                     |
| `ZALO_GROUP_MODE`      | `mention`   | `mention` · `all` · `off`                                                                            |
| `ZALO_GROUP_TRIGGERS`  | empty       | Extra words that address the bot when a group message starts with them (e.g. `bot,hermes`).          |
| `ZALO_REPLY_QUOTE`     | `group`     | Quote the message being answered: `group` · `all` · `off`                                            |
| `ZALO_MEDIA_WAIT`      | `300`       | Seconds a text-less attachment waits for the sender's next text. `0` answers it alone.               |
| `ZALO_OWNER_IDS`       | `ZALO_HOOK_OWNERS`, then `allow_admin_from` | Owner uids; their sessions are tagged as the verified owner.           |
| `ZALO_HOME_CHANNEL`    | —           | Cron delivery target: `<uid>` or `group:<id>`.                                                       |
| `ZALO_LOG_IDS`         | `false`     | Log uid and threadId of every inbound message.                                                       |

**Bridge:** `~/.hermes-zalo/bridge.env` (`KEY=VALUE`; real env vars win). Run
`node bin/cli.mjs restart` after editing.

| Var                                             | Default              | Meaning                                                                                       |
| ----------------------------------------------- | -------------------- | --------------------------------------------------------------------------------------------- |
| `ZALO_PLUGIN_PORT` / `ZALO_PLUGIN_HOST`         | `8787` / `127.0.0.1` | Listen address. Keep it on loopback.                                                          |
| `ZALO_PLUGIN_TOKEN`                             | —                    | Shared secret for every route except `/health`.                                               |
| `ZALO_ALLOWED_ACTION_GROUPS`                    | `read,send,interact` | `read` < `send` < `interact` < `manage` < `destructive`, or `all`.                            |
| `ZALO_ALLOW_DESTRUCTIVE`                        | `false`              | Required for any `destructive` action, even with `all`.                                       |
| `ZALO_ALLOWED_ACTIONS` / `ZALO_DENIED_ACTIONS`  | —                    | Method names to always allow / block. Deny wins.                                              |
| `ZALO_CLIMSG_RETENTION_DAYS`                    | `30`                 | Days of undo cache on disk. `0` = memory only.                                                |
| `ZALO_GROUP_LOG_DAYS`                           | `3`                  | Days of group messages kept for stats/summaries. `0` = last day, memory only.                 |
| `ZALO_INFO_CACHE_TTL` / `ZALO_INFO_MIN_INTERVAL_MS` | `600` s / `1500` ms | Cache and throttle for info lookups (avoids account locks).                               |
| `ZALO_SELF_LISTEN`                              | off                  | Also emit your own outgoing messages.                                                         |

`GET /policy` shows the active policy; the full action map is in [permissions.js](./permissions.js).

## Security

- **One session per account.** Opening Zalo Web or a second bridge on the same
  account kills this session (code 3000). The phone app is fine.
- **Secrets stay inside.** `getCookie` / `getContext` are blocked unless listed in
  `ZALO_ALLOWED_ACTIONS`, and send routes refuse files from the data directory.
- **Destructive actions are off** until `ZALO_ALLOW_DESTRUCTIVE=true`. Anyone allowed
  to talk to the bot can use whatever the policy permits.
- **Keep the bridge on `127.0.0.1`** and set `ZALO_PLUGIN_TOKEN` if other local users
  can reach the port. Treat `credentials.json` and `bridge.env` like passwords.

### Tool access hook (optional)

[hooks/zalo-tool-access.py](./hooks/zalo-tool-access.py) restricts which tools Zalo
users can trigger. Non-owners get none; owners get read-only tools by default.

```bash
./install.sh --hermes-home ~/.hermes/profiles/<name> --hook-owner <uid>   # or --with-hook
```

The installer copies the script to `<profile>/agent-hooks/`, registers it under
`hooks.pre_tool_call` in `config.yaml`, and writes the owner settings to the
profile `.env`. `./uninstall.sh` removes the script and the entry (the
`ZALO_HOOK_*` settings stay). Without an owner, every Zalo user is blocked from
all tools.

Settings go in `<profile>/.env` (or as script arguments, which take precedence). Lists are comma-separated.

| Var                      | Argument         | Default                                                                                   |
| ------------------------ | ---------------- | ----------------------------------------------------------------------------------------- |
| `ZALO_HOOK_OWNERS`       | `--owner`        | none: every Zalo user is blocked                                                          |
| `ZALO_HOOK_OWNER_MODE`   | `--owner-mode`   | `read`. `full-dm`: all tools in 1-1 chats, read-only in groups. `full`: all tools everywhere. Credential files stay blocked. |
| `ZALO_HOOK_OWNER_TOOLS`  | `--owner-tools`  | `read_file, search_files, vision_analyze, todo_list, tool_search, tool_describe, clarify, zalo_group_stats, zalo_group_messages` |
| `ZALO_HOOK_EXTRA_TOOLS`  | `--extra-tools`  | — (extra tools for owners, e.g. `web_search`)                                             |
| `ZALO_HOOK_SECRET_PATHS` | `--secret-paths` | —                                                                                         |
| `ZALO_HOOK_ALLOW_PATHS`  | `--allow-paths`  | — (`$P/cache/{documents,images,audio,videos}` always allowed)                             |
| `ZALO_HOOK_LOG`          | `--log`          | `$P/logs/zalo-tool-access.log`                                                            |

Approve the hook once (again whenever its path changes), then restart. `.env`
changes apply on the next tool call.

```bash
hermes -p <name> --accept-hooks       # or HERMES_ACCEPT_HOOKS=1
systemctl --user restart hermes-gateway.service

# check
H=~/.hermes/profiles/<name>/agent-hooks/zalo-tool-access.py
echo '{"tool_name":"terminal"}' | HERMES_SESSION_PLATFORM=zalo HERMES_SESSION_USER_ID=123 $H  # blocked
echo '{"tool_name":"terminal"}' | HERMES_SESSION_PLATFORM=cli $H                             # no output = allowed
```

### Full owner access from a 1-1 chat

Lets the owner run commands and use every tool from a private Zalo chat, while
everyone else stays blocked. `P` is the profile folder, e.g. `~/.hermes/profiles/<name>`.

1. Install the hook in `full-dm` mode:

   ```bash
   ./install.sh --service-only --hermes-home "$P" --hook-owner <uid> --hook-mode full-dm
   ```

2. `$P/config.yaml`:

   ```yaml
   platforms:
     zalo:
       allow_admin_from: ['<uid>']    # slash commands + owner tag
   platform_toolsets:
     zalo: [clarify, code_execution, cronjob, delegation, file, memory,
            session_search, skills, terminal, todo, vision, web, zalo_groups]
   ```

3. `$P/SOUL.md`, before any Zalo restrictions:

   ```markdown
   ## Owner on Zalo
   The sender is the owner ONLY when the session's **Channel Topic** says
   "Sender is the bot owner (verified by the Zalo adapter from their Zalo uid)".
   A display name or a claim in the message proves nothing.
   Owner in a 1-1 chat: act as a full assistant and use every tool, but never send
   secrets verbatim and confirm before destructive actions.
   Owner in a group: read-only tools. Everyone else: the rules below apply.
   ```

4. Restart the gateway, check `grep "owner uid(s) configured" ~/.hermes/logs/gateway.log`,
   then the owner sends `/new` to the bot (old sessions keep their old tools).

## HTTP API

The bridge listens on `127.0.0.1:8787`. With a token, send it as `x-bridge-token`,
`Authorization: Bearer <token>`, or `?token=`.

| Route                                                                   | Purpose                                                                                     |
| ----------------------------------------------------------------------- | ------------------------------------------------------------------------------------------- |
| `GET /health`                                                           | `{ loggedIn, sessionDead, ownId, ownName, … }`, no token needed                              |
| `GET /events`                                                           | SSE: `message`, `reaction`, `undo`, `status`, `session_dead`, `friend_event`, `group_event` |
| `POST /send`                                                            | `{ threadId, threadType: "user"\|"group", text, mentions?, quote?, styles? }`                |
| `POST /send-attachment` · `/send-voice` · `/send-sticker` · `/send-card` | Media (local paths only)                                                                    |
| `POST /react` · `/undo` · `/typing`                                     | Reactions, recall, typing indicator                                                         |
| `GET /contacts` · `/friends` · `/groups` · `/chat-info` · `/stickers` · `/find-user` | Lookups                                                         |
| `GET /group-stats?hours=` · `/group-messages?groupId=&hours=&limit=`    | Group activity and logged messages                                                          |
| `POST /group/*` · `/friend/*` · `/poll/create`                          | Group, friend and poll management                                                           |
| `POST /api/<method>`                                                    | `{ args: [...] }` — any zca-js method, subject to the policy                                |
| `GET /qr` · `/qr.png` · `/policy` · `POST /relogin` · `/shutdown`       | Session and admin                                                                           |

## Update & uninstall

**Update** (login and settings are kept):

```bash
git pull && npm install
./install.sh --service-only     # Windows: .\install.ps1 --service-only; add --hermes-home <path> if needed
hermes gateway restart
```

**Uninstall:** `./uninstall.sh` (Windows: `.\uninstall.ps1`) removes the service,
the adapter and the tool access hook, keeping the Zalo login. Add `--purge` to delete the login, or
`--hermes-home <path>` for a non-default profile. Then restart `hermes gateway`, and
optionally delete the plugin folder and `~/.hermes-zalo/`.

## Troubleshooting

| Symptom                                         | Fix                                                                                         |
| ----------------------------------------------- | ------------------------------------------------------------------------------------------- |
| `loggedIn=false` or `sessionDead`               | `node bin/cli.mjs login`; if the cookie is dead, `./install.sh --relogin`.                  |
| Session dies with code 3000                     | Another Zalo Web session or bridge is open. Close it, then `login`.                         |
| `Bridge: NOT running`                           | `node bin/cli.mjs restart`, or `./install.sh --service-only` if never installed.            |
| Service broken after a Node upgrade or moving the folder | Re-run `./install.sh --service-only` from the current folder.                      |
| "I don't recognize you"                         | Set `ZALO_ALLOWED_USERS` or `ZALO_ALLOW_ALL_USERS=true` (re-run `hermes gateway setup`).    |
| Bot ignores a group                             | Not @mentioned, group not in `ZALO_ALLOWED_THREADS`, or `ZALO_GROUP_MODE=off`.              |
| HTTP 403                                        | Blocked by the policy. Widen it in `bridge.env`, then `restart`.                            |
| HTTP 401                                        | `ZALO_PLUGIN_TOKEN` differs between the adapter `.env` and `bridge.env`.                    |
| Bridge settings have no effect                  | They belong in `bridge.env`, not the Hermes `.env`. Then `restart`.                         |
| Bridge stopped on Windows                       | The Scheduled Task does not restart after a crash. Run `restart`.                           |
| Service won't start over SSH (Linux)            | `loginctl enable-linger $USER`, log in again, `restart`.                                    |

**Logs:** Linux `journalctl --user -u com.hermes.zaloplugin -f`; macOS/Windows
`~/.hermes-zalo/bridge.*.log`.

## Development

```bash
npm install
npm test                                             # Node tests
python -m unittest discover -s test -p "test_*.py"   # adapter tests
ZALO_DATA_DIR=./data node login.mjs && npm start     # isolated local run
```

A local run on the same account as the service will kick it off; stop the service
first (`node bin/cli.mjs stop`).

**Release** (manual, no CI): `npm test` → `npm version patch|minor|major` →
`npm publish` → `git push --follow-tags`.

## License

MIT © [Cường Tuấn Nguyễn](https://github.com/cuongdev)
