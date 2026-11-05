<p align="center">
  <img src="./assets/logo.svg" alt="hermes-zalo-plugin" width="660">
</p>

# hermes-zalo-plugin

📖 **English** · [Tiếng Việt](./README.vi.md)

[![license](https://img.shields.io/badge/license-MIT-blue.svg)](./LICENSE)

Chat with your **Hermes Agent** from a **personal Zalo account**: private chats
and groups, with images, files, voice, stickers and reactions. Runs on macOS,
Linux and Windows.

> ⚠️ Built on [zca-js](https://www.npmjs.com/package/zca-js), an **unofficial**
> Zalo API. Zalo may rate-limit or lock automated accounts. Use a secondary account.

## Contents

1. [Quick start](#quick-start)
2. [Install](#install)
   - [Ways to run the installer](#ways-to-run-the-installer)
   - [What the installer does](#what-the-installer-does)
   - [Choosing the Hermes profile](#choosing-the-hermes-profile)
   - [Install options](#install-options)
   - [Environment variables read by the installer](#environment-variables-read-by-the-installer)
   - [Install examples](#install-examples)
   - [What gets installed where](#what-gets-installed-where)
3. [Update](#update)
4. [Uninstall](#uninstall)
5. [How it works](#how-it-works)
6. [CLI commands](#cli-commands)
7. [Usage](#usage)
8. [Configuration](#configuration)
9. [Security](#security)
10. [HTTP API](#http-api)
11. [Troubleshooting](#troubleshooting)
12. [Development](#development)

## Quick start

**Requirements:** Node.js ≥ 18, Hermes Agent (with `pip install aiohttp`), and the
Zalo phone app to scan a QR code.

```bash
# 1. Get the code. Keep the folder: the background service runs from it.
git clone https://github.com/pdt590/chatbot-personal-zalo-hermes.git
cd chatbot-personal-zalo-hermes

# 2. Install: dependencies → QR login → background service → Hermes adapter.
./install.sh                         # Windows: .\install.ps1
# …or into a named Hermes profile:
./install.sh --profile <name>

# 3. Connect to Hermes (add -p <name> for a named profile).
hermes gateway setup                 # choose "Zalo": allowed users, groups, permissions
hermes gateway                       # start chatting
```

The rest of this section explains every option. If the defaults suit you, you are
done.

## Install

### Ways to run the installer

All of these run the same installer (`install.mjs`) and take the same
[options](#install-options):

| Command                                  | When to use                                                       |
| ---------------------------------------- | ----------------------------------------------------------------- |
| `./install.sh [options]`                 | macOS / Linux, from a git checkout.                               |
| `.\install.ps1 [options]`                | Windows PowerShell, from a git checkout.                          |
| `node install.mjs [options]`             | Any OS, from a git checkout.                                      |
| `node bin/cli.mjs setup [options]`       | Same, through the [CLI](#cli-commands).                           |

On Windows, if PowerShell blocks the script, first run
`Set-ExecutionPolicy -Scope Process -ExecutionPolicy Bypass`.

The installer is **safe to re-run**: dependencies are only installed when missing,
the QR scan is skipped while the saved session is valid, the service is
re-registered and restarted on the new code, and the adapter files are
overwritten.

### What the installer does

| Step | Action                                                                                                         | Skipped by           |
| ---- | -------------------------------------------------------------------------------------------------------------- | -------------------- |
| 0    | Checks Node ≥ 18 and `npm`, and resolves the [Hermes profile](#choosing-the-hermes-profile).                   | —                    |
| 1    | `npm install` if `node_modules/zca-js` is missing.                           | `--service-only`     |
| 2    | Zalo QR login (reuses the saved session if it still works).                                                    | `--service-only`     |
| 3    | Registers the bridge as a background service: systemd user unit (Linux), launchd agent (macOS), Scheduled Task at logon (Windows). | `--no-service` |
| 4    | Copies the Python adapter into `<profile>/plugins/zalo`, adds `zalo-platform` to `plugins.enabled` and the plugin toolsets to `platform_toolsets.zalo` in `<profile>/config.yaml`. | default profile missing |
| 5    | Optional [tool access hook](#tool-access-hook-optional): copies it to `<profile>/agent-hooks/`, registers it under `hooks.pre_tool_call`, writes owner settings to `<profile>/.env`. | runs only with a hook option, or when the hook is already installed |

`<profile>` is the folder of the chosen Hermes profile.

### Choosing the Hermes profile

Hermes can run several independent profiles (`hermes profile list`). The adapter
and the hook are installed into **one** profile, picked by its **name**. The
installer turns the name into a folder exactly like `hermes -p <name>` does:

| Profile name | Folder (macOS / Linux)      | Folder (Windows)                         |
| ------------ | --------------------------- | ---------------------------------------- |
| `default`    | `~/.hermes`                 | `%LOCALAPPDATA%\hermes`                  |
| `<name>`     | `~/.hermes/profiles/<name>` | `%LOCALAPPDATA%\hermes\profiles\<name>`  |

The target comes from the first of these that is set:

| # | Source                           | Example                                  | Notes                                                         |
| - | -------------------------------- | ---------------------------------------- | ------------------------------------------------------------- |
| 1 | `--profile <name>` / `-p <name>` | `--profile work`, `-p=work`              | Recommended.                                                  |
| 2 | `--hermes-home <path>`           | `--hermes-home /srv/hermes/work`         | Explicit folder. Cannot be combined with `--profile`.         |
| 3 | `HERMES_PROFILE` env var         | `HERMES_PROFILE=work ./install.sh`       | Same as `--profile`.                                          |
| 4 | `HERMES_HOME` env var            | `HERMES_HOME=/srv/hermes ./install.sh`   | Explicit folder.                                              |
| 5 | nothing                          | `./install.sh`                           | The `default` profile, **only if its folder already exists**. |

Rules:

- **Profile names** use lowercase letters, numbers, `-` and `_`, start with a letter
  or number, and are at most 64 characters. Upper case is lowered (`Work` → `work`).
  Anything else (`../x`, `my profile`) is rejected.
- **A named profile must already exist.** Create it with `hermes profile create <name>`.
  A missing or mistyped name stops the installer **before** it logs in, touches the
  service or writes any file.
- **The default profile is never created.** If `~/.hermes` does not exist, the
  adapter step is skipped with a warning; the bridge itself still works.
- An explicit folder (`--hermes-home` / `HERMES_HOME`) is created if missing.
- **Custom Hermes root:** when `HERMES_HOME` points outside `~/.hermes` (e.g.
  `/opt/data` in Docker), `--profile <name>` resolves to `$HERMES_HOME/profiles/<name>`.
- The adapter step prints what was picked, e.g.
  `Hermes profile: work → /home/me/.hermes/profiles/work (--profile work)`.

### Install options

| Option                    | Value                         | Effect                                                                                                        |
| ------------------------- | ----------------------------- | ------------------------------------------------------------------------------------------------------------- |
| `-p`, `--profile`         | profile name                  | Hermes profile to install the adapter (and hook) into. See [above](#choosing-the-hermes-profile).             |
| `--hermes-home`           | folder                        | Advanced: install into this folder instead of a profile. `~` is expanded.                                     |
| `--service-only`          | —                             | Only steps 3–5: (re)install the service and the adapter. No dependency install, no login. Use after updates. |
| `--no-service`            | —                             | Skip step 3. Run the bridge yourself with `node bin/cli.mjs start` / `npm start`.                           |
| `--relogin` (`--force`)   | —                             | Force a new QR scan. A running service is stopped first and started again afterwards.                         |
| `--with-hook`             | —                             | Also install the tool access hook (with no owner set, every Zalo user is blocked from all tools).             |
| `--hook-owner`            | uid list: `123` or `123,456`  | Install the hook and write `ZALO_HOOK_OWNERS` to `<profile>/.env`. Digits only, comma-separated.              |
| `--hook-mode`             | `read` · `full-dm` · `full`   | Install the hook and write `ZALO_HOOK_OWNER_MODE` to `<profile>/.env`.                                        |

Values can be given as `--option value` or `--option=value`. Notes:

- `--service-only` wins over `--relogin` and `--no-service`.
- Any of `--with-hook`, `--hook-owner`, `--hook-mode` installs the hook. Once the
  hook is installed, every later run updates it even without these options.
- Leaving out `--hook-owner` / `--hook-mode` on a re-run keeps the values already
  in `.env`.

### Environment variables read by the installer

| Variable                                                 | Effect                                                                                          |
| -------------------------------------------------------- | ----------------------------------------------------------------------------------------------- |
| `HERMES_PROFILE`                                         | Profile name, same as `--profile` (lower priority than the flags).                              |
| `HERMES_HOME`                                            | Hermes folder, same as `--hermes-home`. With `--profile`, the root that holds `profiles/`.      |
| `ZALO_DATA_DIR`                                          | Bridge data folder (login, `bridge.env`, logs). Default `~/.hermes-zalo`.                       |
| `ZALO_BRIDGE_ENV`, `ZALO_CREDENTIALS_PATH`, `ZALO_QR_PATH`, `ZALO_CLIMSG_DIR`, `ZALO_LOG_DIR` | Override single bridge files or folders.                   |
| `ZALO_PLUGIN_PORT`                                       | Only changes the URL printed at the end; the bridge reads its port from `bridge.env`.           |

The `ZALO_*` path variables you install with are written into the service
definition, so the background bridge uses the same locations. Set them again on
every re-run (and on uninstall) that should keep them.

### Install examples

```bash
# Default profile (~/.hermes), full setup
./install.sh

# A named profile
hermes profile create work                    # only if it does not exist yet
./install.sh --profile work
hermes -p work gateway setup

# Same, via environment variable
HERMES_PROFILE=work ./install.sh

# Add the adapter to a second profile (bridge and login already set up)
./install.sh --service-only --profile lily

# Hook with an owner who gets every tool in 1-1 chats
./install.sh --service-only --profile work --hook-owner 1234567890 --hook-mode full-dm

# Log in again with a new QR (e.g. after the session died)
./install.sh --relogin

# No background service: run the bridge in a terminal yourself
./install.sh --no-service --profile work
node bin/cli.mjs start

# Keep bridge data somewhere else
ZALO_DATA_DIR=/srv/zalo ./install.sh --profile work

# Docker / custom root: profiles live under $HERMES_HOME/profiles
HERMES_HOME=/opt/data ./install.sh --profile work   # → /opt/data/profiles/work

# Explicit folder that is not a standard profile
./install.sh --hermes-home ~/hermes-test
```

```powershell
# Windows
.\install.ps1 --profile work
$env:HERMES_PROFILE = "work"; .\install.ps1
```

### What gets installed where

| What              | Location                                                                                                    |
| ----------------- | ----------------------------------------------------------------------------------------------------------- |
| Bridge code       | The git checkout. The service runs from here: don't move or delete it.                                      |
| Bridge data       | `~/.hermes-zalo/` (`ZALO_DATA_DIR`): `credentials.json`, `bridge.env`, `qr.png`, undo cache, group log, logs. |
| Service (Linux)   | `~/.config/systemd/user/com.hermes.zaloplugin.service`                                                      |
| Service (macOS)   | `~/Library/LaunchAgents/com.hermes.zaloplugin.plist`                                                        |
| Service (Windows) | Scheduled Task `HermesZaloPlugin` + `~/.hermes-zalo/bridge-launcher.cmd`                                    |
| Adapter           | `<profile>/plugins/zalo/`                                                                                   |
| Hermes config     | `<profile>/config.yaml` (`plugins.enabled`, `platform_toolsets.zalo`, `hooks.pre_tool_call`)                |
| Hook (optional)   | `<profile>/agent-hooks/zalo-tool-access.py`, settings in `<profile>/.env`                                   |

There is **one bridge per machine** (one Zalo account), shared by every profile;
each profile has **its own copy** of the adapter.

## Update

Login and settings are kept.

```bash
git pull && npm install
./install.sh --service-only --profile <name>    # repeat for every profile that has the adapter
hermes -p <name> gateway restart                # default profile: hermes gateway restart
```

Leave out `--profile` for the default profile. If you installed with `ZALO_*` path
variables, set them again here.

## Uninstall

### Commands

| Command                                   | When to use                            |
| ----------------------------------------- | -------------------------------------- |
| `./uninstall.sh [options]`                | macOS / Linux, from a git checkout.    |
| `.\uninstall.ps1 [options]`               | Windows PowerShell.                    |
| `node uninstall.mjs [options]`            | Any OS.                                |
| `node bin/cli.mjs uninstall [options]`    | Same, through the [CLI](#cli-commands). |

### Uninstall options

| Option / variable                        | Value        | Effect                                                                              |
| ---------------------------------------- | ------------ | ----------------------------------------------------------------------------------- |
| `-p`, `--profile`                        | profile name | Remove the adapter and hook from this profile. Same rules as for install.           |
| `--hermes-home`                          | folder       | Remove them from this folder instead.                                               |
| `HERMES_PROFILE` / `HERMES_HOME`         | env vars     | Same as above, lower priority than the flags.                                       |
| `--purge`                                | —            | Also delete the saved Zalo login (`credentials.json`). The next install shows a QR. |
| `ZALO_DATA_DIR`, `ZALO_CREDENTIALS_PATH` | env vars     | Where to find the login if you moved it.                |

Unlike install, a missing profile is not an error: uninstall reports that there is
nothing to remove there and carries on.

### What is removed and what is kept

| Removed                                                                | Kept                                                       |
| ---------------------------------------------------------------------- | ---------------------------------------------------------- |
| The background service (stopped and unregistered)                      | The bridge code (git checkout)                  |
| `<profile>/plugins/zalo/`                                              | `~/.hermes-zalo/` (`bridge.env`, logs, caches)             |
| `zalo-platform` in `plugins.enabled` of `<profile>/config.yaml`        | The Zalo login, unless `--purge`                           |
| The hook file and its `hooks.pre_tool_call` entry                      | `ZALO_*` lines in `<profile>/.env` (reused on reinstall)   |
|                                                                        | `platform_toolsets.zalo` and the rest of `config.yaml`     |

Uninstall always removes the **service** together with the adapter of the chosen
profile. To remove Zalo from one profile but keep it in another, uninstall and
then reinstall for the profile you keep:

```bash
./uninstall.sh --profile work
./install.sh --service-only --profile lily
```

### Uninstall examples

```bash
./uninstall.sh                                  # default profile, keep the login
./uninstall.sh --profile work                   # named profile
HERMES_PROFILE=work ./uninstall.sh              # same, via environment
./uninstall.sh --profile work --purge           # also log out (delete credentials)

# Remove everything
./uninstall.sh --profile work --purge
./uninstall.sh --profile lily                   # every other profile that had the adapter
rm -rf ~/.hermes-zalo                           # bridge data
rm -rf /path/to/the/git/checkout               # bridge code
hermes -p work gateway restart
```

```powershell
# Windows
.\uninstall.ps1 --profile work --purge
```

Restart `hermes gateway` of each affected profile afterwards.

## How it works

```mermaid
flowchart LR
  Z[Zalo servers] <-- "WebSocket in<br/>HTTPS out" --> B["Bridge (Node + zca-js)<br/>background service"]
  B -- "SSE  GET /events" --> A["Hermes adapter (Python)<br/>~/.hermes[/profiles/name]/plugins/zalo"]
  A -- "REST  POST /send, /api/…" --> B
  A <--> H[Hermes gateway + agent]
```

| Part                                      | Runs as                                                                                  | Job                                                                                                                                  |
| ----------------------------------------- | ---------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| **Bridge** (`server.js`, `zaloClient.js`) | systemd user unit (Linux), launchd agent (macOS), Scheduled Task at logon (Windows)       | Keeps the Zalo session alive, streams inbound events over SSE, exposes REST routes for every zca-js method behind an action policy. |
| **Adapter** (`hermes-plugin/`)            | Plugin `zalo-platform` inside `hermes gateway`                                           | Turns events into Hermes messages, downloads media, decides which chats to answer, sends replies through the bridge.               |

## CLI commands

Run from the git checkout: `node bin/cli.mjs <command>`.

| Command               | What it does                                                         |
| --------------------- | -------------------------------------------------------------------- |
| `setup [options]`     | The installer, see [Install options](#install-options).              |
| `uninstall [options]` | The uninstaller, see [Uninstall options](#uninstall-options).        |
| `status`              | Service state, bridge health, logged-in account, data paths.         |
| `login [--force]`     | QR login. A running bridge picks up the new session by itself.       |
| `restart`             | Restart (or start) the service. Needed after editing `bridge.env`.   |
| `stop`                | Stop the service; it stays installed.                                |
| `start`               | Run the bridge in the foreground.                                    |
| `help`                | List commands and options.                                           |

## Usage

<p align="center">
  <img src="./assets/zalo-chat.svg" alt="Chatting with the Hermes agent from Zalo" width="300">
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

`hermes gateway setup` (`hermes -p <name> gateway setup` for a named profile)
writes both files below.

**Adapter:** `<profile>/.env`. Restart `hermes gateway` after editing.

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
./install.sh --profile <name> --hook-owner <uid>   # or --with-hook
```

The installer copies the script to `<profile>/agent-hooks/`, registers it under
`hooks.pre_tool_call` in `config.yaml`, and writes the owner settings to
`<profile>/.env`. `./uninstall.sh --profile <name>` removes the script and the
entry (the `ZALO_HOOK_*` settings stay). Without an owner, every Zalo user is
blocked from all tools.

Settings go in `<profile>/.env` (or as script arguments, which take precedence).
Lists are comma-separated. `$P` below is the profile folder.

| Var                      | Argument         | Default                                                                                   |
| ------------------------ | ---------------- | ----------------------------------------------------------------------------------------- |
| `ZALO_HOOK_OWNERS`       | `--owner`        | none: every Zalo user is blocked                                                          |
| `ZALO_HOOK_OWNER_MODE`   | `--owner-mode`   | `read`. `full-dm`: all tools in 1-1 chats, read-only in groups. `full`: all tools everywhere. Credential files stay blocked. |
| `ZALO_HOOK_OWNER_TOOLS`  | `--owner-tools`  | `read_file, search_files, vision_analyze, todo_list, tool_search, tool_describe, clarify, zalo_group_stats, zalo_group_messages` |
| `ZALO_HOOK_EXTRA_TOOLS`  | `--extra-tools`  | — (extra tools for owners, e.g. `web_search`)                                             |
| `ZALO_HOOK_SECRET_PATHS` | `--secret-paths` | —                                                                                         |
| `ZALO_HOOK_ALLOW_PATHS`  | `--allow-paths`  | — (`$P/cache/{documents,images,audio,videos}` always allowed)                             |
| `ZALO_HOOK_LOG`          | `--log`          | `$P/logs/zalo-tool-access.log`                                                            |

Hermes runs a new or changed hook only after you approve it. The installer prints
the exact command; approve once (again whenever the hook path changes), then
restart. `.env` changes apply on the next tool call.

```bash
hermes -p <name> --accept-hooks       # default profile: hermes --accept-hooks; or HERMES_ACCEPT_HOOKS=1
systemctl --user restart hermes-gateway.service

# check
H=~/.hermes/profiles/<name>/agent-hooks/zalo-tool-access.py
echo '{"tool_name":"terminal"}' | HERMES_SESSION_PLATFORM=zalo HERMES_SESSION_USER_ID=123 $H  # blocked
echo '{"tool_name":"terminal"}' | HERMES_SESSION_PLATFORM=cli $H                             # no output = allowed
```

### Full owner access from a 1-1 chat

Lets the owner run commands and use every tool from a private Zalo chat, while
everyone else stays blocked. `<name>` is the Hermes profile and `P` its folder,
e.g. `P=~/.hermes/profiles/<name>`.

1. Install the hook in `full-dm` mode:

   ```bash
   ./install.sh --service-only --profile <name> --hook-owner <uid> --hook-mode full-dm
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

## Troubleshooting

| Symptom                                                  | Fix                                                                                              |
| -------------------------------------------------------- | ------------------------------------------------------------------------------------------------ |
| `Hermes profile '<name>' not found`                      | Typo, or the profile does not exist yet: `hermes profile list`, `hermes profile create <name>`.  |
| `… is not a valid Hermes profile name`                   | Use lowercase letters, numbers, `-`, `_` (e.g. `my-work`).                                       |
| `use either --profile or --hermes-home, not both`        | Keep only one of the two.                                                                        |
| `Hermes home not found at …/.hermes`, adapter skipped    | No default profile. Pass `--profile <name>`, or install Hermes and re-run with `--service-only`. |
| Zalo missing in `hermes gateway setup`                   | The adapter went into another profile: check the `Hermes profile: …` line and re-run with the right `--profile`. |
| `loggedIn=false` or `sessionDead`                        | `node bin/cli.mjs login`; if the cookie is dead, `./install.sh --relogin`.                     |
| Session dies with code 3000                              | Another Zalo Web session or bridge is open. Close it, then `login`.                              |
| `Bridge: NOT running`                                    | `node bin/cli.mjs restart`, or `./install.sh --service-only` if never installed.               |
| Service broken after a Node upgrade or moving the folder | Re-run `./install.sh --service-only` from the current folder.                                    |
| "I don't recognize you"                                  | Set `ZALO_ALLOWED_USERS` or `ZALO_ALLOW_ALL_USERS=true` (re-run `hermes gateway setup`).         |
| Bot ignores a group                                      | Not @mentioned, group not in `ZALO_ALLOWED_THREADS`, or `ZALO_GROUP_MODE=off`.                   |
| HTTP 403                                                 | Blocked by the policy. Widen it in `bridge.env`, then `restart`.                                 |
| HTTP 401                                                 | `ZALO_PLUGIN_TOKEN` differs between the adapter `.env` and `bridge.env`.                         |
| Bridge settings have no effect                           | They belong in `bridge.env`, not the Hermes `.env`. Then `restart`.                              |
| Bridge stopped on Windows                                | The Scheduled Task does not restart after a crash. Run `restart`.                                |
| Service won't start over SSH (Linux)                     | `loginctl enable-linger $USER`, log in again, `restart`.                                         |

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
