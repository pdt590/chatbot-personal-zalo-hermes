## graphify

This project has a knowledge graph at graphify-out/ with god nodes, community structure, and cross-file relationships.

Rules:
- When graphify-out/graph.json exists, run `graphify query "<question>"` before your first grep, search or source-file read for a codebase question, and put this rule in every subagent prompt that explores code. Read raw files only for lines the graph or an earlier read already located. Use `graphify path "<A>" "<B>"` for relationships and `graphify explain "<concept>"` for focused concepts. These return a scoped subgraph, usually much smaller than GRAPH_REPORT.md or raw grep output.
- If graphify-out/wiki/index.md exists, use it for broad navigation instead of raw source browsing.
- Read graphify-out/GRAPH_REPORT.md only for broad architecture review or when query/path/explain do not surface enough context.
- After modifying code, run `graphify update .` to keep the graph current (AST-only, no API cost).
- A committed graphify-out/graph.json is rewritten whole on every build, so a large diff to it in a pull request is expected. Do not flag it as churn or suggest skipping the graph rebuild or its hooks.

## End-to-end testing (Lily bot via Hubplus account + opencli)

You may use the Zalo account **Hubplus** (logged in on chat.zalo.me in the opencli-bound Chrome) to chat with the bot **Lily** (bridge `ownId=640788907767712047`, Hermes profile `zalo8806`). Only send test messages to Lily from this account, never to anyone else.

1. Install the build under test and reload everything:
   ```bash
   npm pack --pack-destination "$SCRATCH" && npm install -g "$SCRATCH"/hermes-zalo-plugin-<ver>.tgz
   hermes-zalo-plugin setup --service-only                                        # restart bridge service + copy plugin to ~/.hermes
   hermes-zalo-plugin setup --service-only --hermes-home ~/.hermes/profiles/zalo8806  # Lily's profile has its OWN plugin copy
   systemctl --user restart hermes-gateway.service
   hermes-zalo-plugin status          # expect loggedIn=true ownName=Lily
   grep -i zalo ~/.hermes/logs/gateway.log | tail -2   # expect "✓ zalo connected (profile: zalo8806)"
   ```
2. Open the chat (`opencli doctor` must report `extensionConnected:true`):
   ```bash
   S="opencli browser --session zalotest"
   $S open "https://chat.zalo.me/?c=621609987858606383"
   ```
   That link opens Hubplus's own profile modal, not the chat. Close it (`$S keys Escape`), then search for Lily:
   ```bash
   $S type "#contact-search-input" "Lily"
   $S eval "[...document.querySelectorAll('.ReactVirtualized__Grid *')].find(e=>!e.childElementCount&&e.textContent.trim()==='Lily').click()"
   ```
3. Send a message. Enter does **not** send; click the send button:
   ```bash
   $S type "#richInput" "test: hôm nay là thứ mấy?"
   $S click ".send-msg-btn"
   ```
4. Wait 30–90s. The agent may compress context first. Then read the reply:
   ```bash
   $S eval "[...document.querySelectorAll('.chat-message')].slice(-4).map(e=>e.innerText).join('\n---\n')"
   $S screenshot "$SCRATCH/zalo.png"
   ```
   Trace the turn in `~/.hermes/profiles/zalo8806/logs/agent.log` (look for `platform=zalo` / `[Zalo] Sending response`). From Lily's side, the Hubplus DM chat id is `3171711652335521231`.
