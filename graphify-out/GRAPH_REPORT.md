# Graph Report - chatbot-personal-zalo-hermes  (2026-11-05)

## Corpus Check
- 34 files · ~48,797 words
- Verdict: corpus is large enough that graph structure adds value.
- Unclassified: 3 file(s) not represented in the graph (top: (none) 3)

## Summary
- 690 nodes · 1313 edges · 30 communities (17 shown, 13 thin omitted)
- Extraction: 96% EXTRACTED · 4% INFERRED · 0% AMBIGUOUS · INFERRED: 55 edges (avg confidence: 0.87)
- Token cost: 0 input · 0 output

## Graph Freshness
- Built from commit: `11e620ad`
- Run `git rev-parse HEAD` and compare to check if the graph is stale.
- Run `graphify update .` after code changes (no API cost).

## Community Hubs (Navigation)
- Zalo Bridge Client (Node)
- Python Adapter Actions
- Adapter Setup & Config
- .test_provides_match_register
- server.js
- npm Package Manifest
- Architecture & Safety Concepts
- markdownToZalo.js
- GroupLog
- install.mjs
- Hermes Plugin Manifest
- paths.js
- Setup Flow Diagram
- Zalo Chat Illustration
- Logo Design
- hermesConfig.js
- BridgeCliTest
- QuotedReplyTest
- test_adapter.py
- PROPOSAL — Rà soát, sửa lỗi và refactor hermes-zalo-plugin (v1.0.12)
- CLAUDE.md
- TargetTest
- ThreadTypeTest
- ToolAccessHookTest
- StripLeadingNameTest
- zalo-tool-access.py
- GroupToolsTest
- HeldMediaTest
- Cfg
- SendImageTest

## God Nodes (most connected - your core abstractions)
1. `ZaloAdapter` - 63 edges
2. `ZaloClient` - 62 edges
3. `ToolAccessHookTest` - 20 edges
4. `hermes-zalo-plugin (README)` - 15 edges
5. `serviceInstalled()` - 14 edges
6. `GroupLog` - 14 edges
7. `restartService()` - 13 edges
8. `interactive_setup()` - 12 edges
9. `log()` - 12 edges
10. `main()` - 12 edges

## Surprising Connections (you probably didn't know these)
- `1.3 `listener.stop()` sinh sự kiện `closed` giả, kích hoạt auto-relogin sai` --references--> `stop()`  [INFERRED]
  PROPOSAL.md → bin/cli.mjs
- `5. Ngoài phạm vi (chỉ ghi nhận)` --references--> `check_requirements()`  [INFERRED]
  PROPOSAL.md → hermes-plugin/adapter.py
- `5. Ngoài phạm vi (chỉ ghi nhận)` --references--> `restart()`  [INFERRED]
  PROPOSAL.md → bin/cli.mjs
- `5. Ngoài phạm vi (chỉ ghi nhận)` --references--> `stop()`  [INFERRED]
  PROPOSAL.md → bin/cli.mjs
- `4. Refactor` --references--> `loadBridgeEnv()`  [INFERRED]
  PROPOSAL.md → paths.js

## Import Cycles
- None detected.

## Hyperedges (group relationships)
- **Four-step onboarding flow: install, QR login, register in Hermes, chat from Zalo** — assets_setup_flow_step_install, assets_setup_flow_step_qr_login, assets_setup_flow_step_register_hermes, assets_setup_flow_step_chat_from_zalo [EXTRACTED 1.00]
- **One-time setup flow** — readme_installer, readme_qr_login, readme_background_service, readme_hermes_gateway_setup_wizard [EXTRACTED 1.00]
- **Zalo <-> Hermes message relay flow** — readme_zca_js, readme_node_bridge, readme_sse_events_stream, readme_rest_outbound_routes, readme_hermes_zalo_adapter, readme_hermes_agent [EXTRACTED 1.00]
- **Hermes assistant capabilities demoed over Zalo** — assets_zalo_chat_hermes_agent, assets_zalo_chat_zalo_messenger, assets_zalo_chat_reminder_use_case, assets_zalo_chat_email_summary_use_case [INFERRED 0.85]
- **Account safety and access controls** — readme_action_permission_policy, readme_sender_thread_access_control, readme_info_call_rate_limiting, readme_bridge_token_auth, readme_unofficial_api_risk [INFERRED 0.85]

## Communities (30 total, 13 thin omitted)

### Community 0 - "Zalo Bridge Client (Node)"
Cohesion: 0.06
Nodes (5): 1.3 `listener.stop()` sinh sự kiện `closed` giả, kích hoạt auto-relogin sai, 2. Lỗi mức trung bình, gracefulShutdown(), readImageMetadata(), ZaloClient

### Community 2 - "Adapter Setup & Config"
Cohesion: 0.05
Nodes (28): _bridge_cli_cmd(), _bridge_cli_hint(), _bridge_env_path(), _bridge_get(), check_requirements(), _current_zalo_group(), _env_enablement(), _fetch_contacts() (+20 more)

### Community 4 - "server.js"
Cohesion: 0.05
Nodes (39): cliMsgDir(), groupLogDir(), ACTION_GROUP, ACTION_GROUPS, createPolicy(), check(), describe(), _csv() (+31 more)

### Community 5 - "npm Package Manifest"
Cohesion: 0.08
Nodes (28): bugs, url, dependencies, express@^4.21.2, qrcode@^1.5.4, qrcode-terminal@^0.12.0, zca-js@^2.2.0, description (+20 more)

### Community 6 - "Architecture & Safety Concepts"
Cohesion: 0.11
Nodes (23): Python aiohttp dependency, Generic /api/<method> passthrough (145-API parity), Background service (launchd / systemd / Scheduled Task), ZALO_PLUGIN_TOKEN shared-secret auth, GET /contacts endpoint, Bridge env configuration (ZALO_* vars, ~/.hermes-zalo data dir), GET /health endpoint, Hermes Agent gateway (+15 more)

### Community 7 - "markdownToZalo.js"
Cohesion: 0.12
Nodes (21): COLOR_ALIAS_RE, COLOR_ALIASES, COLORS, countStylesIn(), CUT_MARKERS, findChunkEnd(), fitsZaloLimits(), formatAndChunkZaloMarkdown() (+13 more)

### Community 9 - "install.mjs"
Cohesion: 0.08
Nodes (55): __dirname, help(), restart(), ROOT, status(), stop(), argv, checkPrereqs() (+47 more)

### Community 10 - "Hermes Plugin Manifest"
Cohesion: 0.11
Nodes (18): author, description, kind, label, name, optional_env, description, name (+10 more)

### Community 11 - "paths.js"
Cohesion: 0.13
Nodes (22): bridgeAlreadyLoggedIn(), CREDENTIALS_PATH, main(), probeBridge(), QR_PATH, reloadRunningBridge(), expandUserPath(), flagValue() (+14 more)

### Community 12 - "Setup Flow Diagram"
Cohesion: 0.31
Nodes (9): Hermes Agent, Hermes Gateway, hermes-zalo-plugin, Setup Flow Diagram (setup in 4 steps), Step 4: Chat from Zalo, Step 1: Install (npm i -g hermes-zalo-plugin), Step 2: Log in via terminal QR (hermes-zalo-plugin setup), Step 3: Register in Hermes (hermes gateway setup, choose Zalo) (+1 more)

### Community 13 - "Zalo Chat Illustration"
Cohesion: 0.53
Nodes (6): Chat Bubble Layout (bot left / user right, input bar), Email Summary Use Case, Hermes Agent (online via Zalo), Reminder Scheduling Use Case, Zalo Chat Illustration (Talk to your Hermes agent from Zalo), Zalo Messenger Channel

### Community 14 - "Logo Design"
Cohesion: 0.50
Nodes (4): hermes-zalo-plugin Logo, Abstract Messenger Mark (chat bubble + speed lines), Tagline: chat with your Hermes agent from Zalo, Hermes x Zalo Wordmark

### Community 15 - "hermesConfig.js"
Cohesion: 0.11
Nodes (25): addPreToolHook(), blockEnd(), disablePluginInConfig(), enablePlatformToolsets(), enablePluginInConfig(), findEnabled(), HOOK_FILE, hookEntry() (+17 more)

### Community 18 - "test_adapter.py"
Cohesion: 0.11
Nodes (4): BridgeEnvTest, EmptyImageTagTest, _load_adapter(), SensitiveActionsTest

### Community 19 - "PROPOSAL — Rà soát, sửa lỗi và refactor hermes-zalo-plugin (v1.0.12)"
Cohesion: 0.14
Nodes (13): stableNodeBin(), 1.1 Cài đặt phía bridge do wizard lưu không bao giờ tới được bridge, 1.2 Lộ cookie phiên Zalo qua `/api/getCookie` với policy mặc định, 1.4 Agent bị dặn sai về markdown, trong khi bridge chuyển markdown sai, 1.5 Adapter in cảnh báo sai về `ZALO_ALLOW_ALL_USERS`, 1. Lỗi nghiêm trọng (phải sửa), 3. Lỗi nhỏ / dọn dẹp, 4. Refactor (+5 more)

### Community 27 - "zalo-tool-access.py"
Cohesion: 0.19
Nodes (10): block(), configure(), log(), lookup(), main(), _Parser, read_dotenv(), secret_path() (+2 more)

### Community 37 - "Cfg"
Cohesion: 0.14
Nodes (3): Cfg, HomeChannelTest, ReplyFieldsTest

## Knowledge Gaps
- **8 isolated node(s):** `Chat Bubble Layout (bot left / user right, input bar)`, `Abstract Messenger Mark (chat bubble + speed lines)`, `permissions.js (auto-generated action-group map)`, `Python aiohttp dependency`, `ZALO_PLUGIN_TOKEN shared-secret auth` (+3 more)
  These have ≤1 connection - possible missing edges or undocumented components. (Counts symbols only; 250 node(s) total have ≤1 connection when file, concept and rationale nodes are included.)
- **13 thin communities (<3 nodes) omitted from report** — run `graphify query` to explore isolated nodes.

## Suggested Questions
_Questions this graph is uniquely positioned to answer:_

- **Why does `5. Ngoài phạm vi (chỉ ghi nhận)` connect `install.mjs` to `Adapter Setup & Config`, `PROPOSAL — Rà soát, sửa lỗi và refactor hermes-zalo-plugin (v1.0.12)`?**
  _High betweenness centrality (0.268) - this node is a cross-community bridge._
- **What connects `Chat Bubble Layout (bot left / user right, input bar)`, `Abstract Messenger Mark (chat bubble + speed lines)`, `permissions.js (auto-generated action-group map)` to the rest of the system?**
  _8 weakly-connected nodes found - possible documentation gaps or missing edges._
- **Should `Zalo Bridge Client (Node)` be split into smaller, more focused modules?**
  _Cohesion score 0.05928614640048397 - nodes in this community are weakly interconnected._
- **Why does `check_requirements()` connect `Adapter Setup & Config` to `install.mjs`?**
  _High betweenness centrality (0.267) - this node is a cross-community bridge._
- **Should `Python Adapter Actions` be split into smaller, more focused modules?**
  _Cohesion score 0.051791629027401385 - nodes in this community are weakly interconnected._
- **Why does `ZaloAdapter` connect `Python Adapter Actions` to `Adapter Setup & Config`?**
  _High betweenness centrality (0.209) - this node is a cross-community bridge._
- **Should `Adapter Setup & Config` be split into smaller, more focused modules?**
  _Cohesion score 0.052884615384615384 - nodes in this community are weakly interconnected._