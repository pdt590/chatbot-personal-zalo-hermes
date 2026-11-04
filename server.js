// server.js
// HTTP bridge: SSE inbound (Zalo -> Hermes) + REST outbound (Hermes -> Zalo).
//
// Settings come from the environment, then from <data dir>/bridge.env (written
// by `hermes gateway setup`; real env vars win). Main keys:
//   ZALO_PLUGIN_PORT      (default 8787)
//   ZALO_PLUGIN_TOKEN     (optional shared secret; required on all routes but /health if set)
//   ZALO_PLUGIN_HOST      (default 127.0.0.1 — keep loopback unless you add TLS)
//   ZALO_CREDENTIALS_PATH (default <data dir>/credentials.json)
//   ZALO_QR_PATH          (default <data dir>/qr.png)
//   ZALO_SELF_LISTEN      (1/true to receive own messages; default off)
//   ZALO_FORCE_QR         (1/true to ignore saved credentials and re-QR)
//   ZALO_ALLOWED_ACTION_GROUPS / ZALO_ALLOW_DESTRUCTIVE /
//   ZALO_ALLOWED_ACTIONS / ZALO_DENIED_ACTIONS   (action policy, see permissions.js)

import crypto from "node:crypto";
import express from "express";
import fs from "node:fs";
import path from "node:path";
import { ZaloClient } from "./zaloClient.js";
import { createPolicy } from "./permissions.js";
import { credentialsPath, qrPath, cliMsgDir, dataDir, loadBridgeEnv } from "./paths.js";

const bridgeEnv = loadBridgeEnv(); // must run before any setting below is read

const envInt = (name, fallback) => {
  const n = parseInt(process.env[name] ?? "", 10);
  return Number.isFinite(n) ? n : fallback;
};
const envFlag = (name) => /^(1|true|yes)$/i.test(process.env[name] || "");

const PORT = envInt("ZALO_PLUGIN_PORT", 8787);
const HOST = process.env.ZALO_PLUGIN_HOST || "127.0.0.1";
const TOKEN = process.env.ZALO_PLUGIN_TOKEN || "";
const CREDENTIALS_PATH = credentialsPath();
const QR_PATH = qrPath();
const SELF_LISTEN = envFlag("ZALO_SELF_LISTEN");
const FORCE_QR = envFlag("ZALO_FORCE_QR");

const client = new ZaloClient({
  credentialsPath: CREDENTIALS_PATH,
  qrPath: QR_PATH,
  selfListen: SELF_LISTEN,
  cliMsgDir: cliMsgDir(),
  // Persisted undo-cache retention in days (0 = memory-only).
  cliMsgRetentionDays: envInt("ZALO_CLIMSG_RETENTION_DAYS", 30),
  infoCacheTtlMs: envInt("ZALO_INFO_CACHE_TTL", 600) * 1000, // env in seconds
  infoMinIntervalMs: envInt("ZALO_INFO_MIN_INTERVAL_MS", 1500),
});

// ── Access control: which zca-js actions are allowed ──────────────────────
const policy = createPolicy(process.env);

if (bridgeEnv.applied.length) {
  console.log(`[bridge] loaded ${bridgeEnv.applied.length} setting(s) from ${bridgeEnv.file}`);
}
console.log(
  `[bridge] access policy: groups=[${[...policy.groups].join(",")}]` +
    ` destructive=${policy.allowDestructive}` +
    (policy.allowed.size ? ` +allow[${[...policy.allowed].join(",")}]` : "") +
    (policy.denied.size ? ` -deny[${[...policy.denied].join(",")}]` : ""),
);

// Map first-class routes → the underlying zca-js action so they're gated by
// the SAME policy as /api/<method>. (GET read routes map to a read method.)
const ROUTE_ACTION = {
  "POST /send": "sendMessage",
  "POST /send-attachment": "uploadAttachment",
  "POST /send-sticker": "sendSticker",
  "POST /send-voice": "sendVoice",
  "POST /send-card": "sendCard",
  "POST /react": "addReaction",
  "POST /undo": "undo",
  "POST /typing": "sendTypingEvent",
  "POST /friend/request": "sendFriendRequest",
  "POST /friend/accept": "acceptFriendRequest",
  "POST /friend/reject": "rejectFriendRequest",
  "GET /friends": "getAllFriends",
  "GET /find-user": "findUser",
  "GET /groups": "getAllGroups",
  "GET /contacts": "getAllGroups",
  "GET /chat-info": "getUserInfo", // getGroupInfo when threadType=group
  "GET /stickers": "getStickers",
  "POST /group/create": "createGroup",
  "POST /group/add": "addUserToGroup",
  "POST /group/remove": "removeUserFromGroup",
  "POST /group/rename": "changeGroupName",
  "POST /group/deputy": "addGroupDeputy",
  "POST /group/leave": "leaveGroup",
  "POST /poll/create": "createPoll",
};

function routeAction(req) {
  if (req.method === "GET" && req.path === "/chat-info" && req.query.threadType === "group") {
    return "getGroupInfo";
  }
  if (req.method === "POST" && req.path.startsWith("/api/")) return req.path.slice("/api/".length);
  return ROUTE_ACTION[`${req.method} ${req.path}`];
}

// ── SSE fan-out ───────────────────────────────────────────────────────────
const sseClients = new Set();
// Small ring buffer so a reconnecting consumer can replay missed events via
// Last-Event-ID (SSE standard). Ids start at the boot time in ms, so they keep
// increasing across bridge restarts and a consumer's Last-Event-ID from the
// previous run correctly replays everything this run has buffered.
const RING_SIZE = 200;
const ring = [];
let nextEventId = Date.now();

const sseFrame = (rec) => `id: ${rec.id}\nevent: ${rec.type}\ndata: ${JSON.stringify(rec.payload)}\n\n`;

function pushEvent(type, payload) {
  const record = { id: nextEventId++, type, payload };
  ring.push(record);
  if (ring.length > RING_SIZE) ring.shift();
  const frame = sseFrame(record);
  for (const res of sseClients) {
    try {
      res.write(frame);
    } catch {
      /* dropped on next heartbeat */
    }
  }
}

for (const type of ["message", "status", "session_dead", "reaction", "undo", "friend_event", "group_event"]) {
  client.on(type, (payload) => pushEvent(type, payload));
}

// ── Helpers ───────────────────────────────────────────────────────────────
class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}
const badRequest = (message) => new HttpError(400, message);
const errMessage = (e) => String(e && e.message ? e.message : e);

/**
 * Wrap a route handler: optional login check, JSON response from the return
 * value, and uniform error replies ({ error }, status from HttpError or 500).
 */
function route(handler, { login = true } = {}) {
  return async (req, res) => {
    if (login && !client.loggedIn) return res.status(503).json({ error: "not logged in" });
    try {
      const out = await handler(req.body || {}, req, res);
      if (out !== undefined && !res.headersSent) res.json(out);
    } catch (e) {
      if (!res.headersSent) res.status(e instanceof HttpError ? e.status : 500).json({ error: errMessage(e) });
    }
  };
}

const ok = (result) => ({ success: true, result });

function requireFields(body, ...names) {
  const missing = names.filter((n) => body[n] == null || body[n] === "");
  if (missing.length) throw badRequest(`${missing.join(" and ")} required`);
}

function requireMembers(body, withGroup = true) {
  if ((withGroup && !body.groupId) || !Array.isArray(body.members) || !body.members.length) {
    throw badRequest(withGroup ? "groupId and members[] required" : "members[] required");
  }
}

// Files the bridge itself owns (session cookie, QR) must never leave the
// machine through a send route, whatever path the caller passes.
const realOrResolved = (p) => {
  try {
    return fs.realpathSync(p);
  } catch {
    return path.resolve(p);
  }
};
const PROTECTED_DIRS = [realOrResolved(dataDir())];
const PROTECTED_FILES = new Set([CREDENTIALS_PATH, QR_PATH].map(realOrResolved));

function assertSendableFile(p) {
  if (typeof p !== "string" || !p) throw badRequest("file path must be a non-empty string");
  if (!fs.existsSync(p)) throw badRequest(`file not found: ${p}`);
  const real = realOrResolved(p);
  const inside = PROTECTED_DIRS.some((d) => real === d || real.startsWith(d + path.sep));
  if (inside || PROTECTED_FILES.has(real)) {
    throw new HttpError(403, `refusing to send the bridge's own data file: ${p}`);
  }
}

function tokenMatches(provided) {
  if (typeof provided !== "string" || !provided) return false;
  const a = Buffer.from(provided);
  const b = Buffer.from(TOKEN);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

// ── Express ─────────────────────────────────────────────────────────────
const app = express();
app.use(express.json({ limit: "2mb" }));

// 1) Auth on everything except /health (liveness probes and `status` CLI).
app.use((req, res, next) => {
  if (!TOKEN || req.path === "/health") return next();
  const provided =
    req.get("x-bridge-token") ||
    (req.get("authorization") || "").replace(/^Bearer\s+/i, "") ||
    req.query.token;
  if (tokenMatches(provided)) return next();
  res.status(401).json({ error: "unauthorized" });
});

// 2) Action policy for first-class routes and /api/<method>. Lifecycle routes
//    (/health, /qr, /events, /relogin, /shutdown, /policy) are never gated.
app.use((req, res, next) => {
  const method = routeAction(req);
  if (method) {
    const v = policy.check(method);
    if (!v.ok) return res.status(403).json({ error: `action '${method}' blocked: ${v.reason}` });
  }
  next();
});

// Active access policy, so the adapter/agent can see what's permitted.
app.get("/policy", route(() => policy.describe(), { login: false }));

app.get("/health", (req, res) => {
  res.json({
    ok: true,
    loggedIn: client.loggedIn,
    sessionDead: !!client.sessionDead,
    sessionDeadReason: client.sessionDeadReason || null,
    ownId: client.ownId,
    ownName: client.ownName || null,
    qr: client.qrState ? client.qrState.status : null,
    sseClients: sseClients.size,
  });
});

// QR status + base64 image (for login UX). Returns current QR state.
app.get(
  "/qr",
  route(() => client.qrState || { status: client.loggedIn ? "logged_in" : "none", image: null }, { login: false }),
);

// Raw QR PNG (convenient to open in a browser/Preview).
app.get("/qr.png", (req, res) => {
  if (fs.existsSync(QR_PATH)) res.sendFile(path.resolve(QR_PATH));
  else res.status(404).json({ error: "no qr available" });
});

// Recover a dead/expired session: re-run login (QR by default; body
// {forceQR:false} reloads saved credentials instead). Responds immediately;
// poll /qr or /qr.png to scan, then /health.
app.post(
  "/relogin",
  route(
    (body) => {
      const forceQR = body.forceQR !== false;
      client
        .relogin({ forceQR })
        .then((r) => console.log("[bridge] relogin complete via", r.method))
        .catch((e) => console.error("[bridge] relogin failed:", errMessage(e)));
      return { success: true, message: "relogin started; poll /qr then /qr.png to scan" };
    },
    { login: false },
  ),
);

// Graceful shutdown of the bridge (a service manager restarts it).
app.post("/shutdown", (req, res) => {
  res.json({ success: true, message: "shutting down" });
  gracefulShutdown("http /shutdown");
});

// SSE inbound stream. Sends a heartbeat every 15s to defeat idle timeouts.
app.get("/events", (req, res) => {
  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache, no-transform",
    Connection: "keep-alive",
    "X-Accel-Buffering": "no",
  });
  res.write(`retry: 3000\n\n`);

  // Replay missed events if the client reconnected with Last-Event-ID.
  const lastId = parseInt(req.get("last-event-id") || req.query.lastEventId || "0", 10);
  if (lastId > 0) {
    for (const rec of ring) if (rec.id > lastId) res.write(sseFrame(rec));
  }

  sseClients.add(res);
  const heartbeat = setInterval(() => {
    try {
      res.write(`: ping\n\n`);
    } catch {
      /* ignore */
    }
  }, 15000);

  req.on("close", () => {
    clearInterval(heartbeat);
    sseClients.delete(res);
  });
});

// ── Messaging ─────────────────────────────────────────────────────────────

// Send text. Body: { threadId, threadType, text, mentions?, quote?, styles? }
//   mentions: [{ pos, uid, len }]  — group @mention
//   quote:    SendMessageQuote captured from an inbound message (reply)
app.post(
  "/send",
  route(async (b) => {
    if (!b.threadId || b.text == null) throw badRequest("threadId and text required");
    return ok(await client.sendText(b.threadId, b.threadType || "user", b.text, b.mentions, b.quote, b.styles));
  }),
);

// Send attachment(s) by local file path(s). Body: { threadId, threadType, paths|path, caption? }
app.post(
  "/send-attachment",
  route(async (b) => {
    const paths = b.paths || (b.path ? [b.path] : null);
    if (!b.threadId || !Array.isArray(paths) || !paths.length) throw badRequest("threadId and paths required");
    paths.forEach(assertSendableFile);
    return ok(await client.sendAttachment(b.threadId, b.threadType || "user", paths, b.caption));
  }),
);

// Send sticker. Body: { threadId, threadType, sticker: { id, cateId, type } }
app.post(
  "/send-sticker",
  route(async (b) => {
    requireFields(b, "threadId", "sticker");
    return ok(await client.sendSticker(b.threadId, b.threadType || "user", b.sticker));
  }),
);

// Send voice. Body: { threadId, threadType, voiceUrl } OR { ..., path } (local file → real voice bubble)
app.post(
  "/send-voice",
  route(async (b) => {
    if (!b.threadId || (!b.voiceUrl && !b.path)) throw badRequest("threadId and (voiceUrl or path) required");
    const tt = b.threadType || "user";
    if (b.path) {
      assertSendableFile(b.path);
      return ok(await client.sendVoiceLocal(b.threadId, tt, b.path));
    }
    return ok(await client.sendVoice(b.threadId, tt, b.voiceUrl));
  }),
);

// Typing indicator. Body: { threadId, threadType }
app.post(
  "/typing",
  route(async (b) => {
    requireFields(b, "threadId");
    await client.sendTyping(b.threadId, b.threadType || "user");
    return { success: true };
  }),
);

// Chat info. GET /chat-info?threadId=..&threadType=user|group
app.get(
  "/chat-info",
  route(async (_b, req) => {
    const { threadId } = req.query;
    if (!threadId) throw badRequest("threadId required");
    if (req.query.threadType === "group") {
      return { threadId, type: "group", info: await client.getGroupInfo(threadId) };
    }
    return { threadId, type: "user", info: await client.getUserInfo(threadId) };
  }),
);

// Search stickers by keyword. GET /stickers?keyword=hi&limit=5
app.get(
  "/stickers",
  route(async (_b, req) => {
    const { keyword } = req.query;
    if (!keyword) throw badRequest("keyword required");
    const n = parseInt(req.query.limit || "5", 10);
    const limit = Number.isFinite(n) ? Math.min(Math.max(n, 1), 50) : 5;
    return { success: true, stickers: await client.findStickers(keyword, limit) };
  }),
);

// ── Reactions / undo / contact card ──────────────────────────────────────
// (/send already supports reply + mention via the quote/mentions fields.)

// React to a message. Body: { threadId, threadType, msgId, cliMsgId?, icon }
// icon = a Reactions key (HEART, LIKE, HAHA, WOW, CRY, ANGRY, …) or raw icon string.
app.post(
  "/react",
  route(async (b) => {
    requireFields(b, "threadId", "msgId");
    return ok(await client.react(b.threadId, b.threadType || "user", b.msgId, b.cliMsgId, b.icon || "HEART"));
  }),
);

// Recall/undo own message. Body: { threadId, threadType, msgId, cliMsgId? }
app.post(
  "/undo",
  route(async (b) => {
    requireFields(b, "threadId", "msgId");
    return ok(await client.undo(b.threadId, b.threadType || "user", b.msgId, b.cliMsgId));
  }),
);

// Send a contact card (danh thiếp). Body: { threadId, threadType, userId, phoneNumber? }
app.post(
  "/send-card",
  route(async (b) => {
    requireFields(b, "threadId", "userId");
    return ok(await client.sendCard(b.threadId, b.threadType || "user", b.userId, b.phoneNumber));
  }),
);

// ── Friends ───────────────────────────────────────────────────────────────
app.post(
  "/friend/request",
  route(async (b) => {
    requireFields(b, "userId");
    return ok(await client.sendFriendRequest(b.userId, b.msg));
  }),
);
app.post(
  "/friend/accept",
  route(async (b) => {
    requireFields(b, "userId");
    return ok(await client.acceptFriendRequest(b.userId));
  }),
);
app.post(
  "/friend/reject",
  route(async (b) => {
    requireFields(b, "userId");
    return ok(await client.rejectFriendRequest(b.userId));
  }),
);
app.get("/friends", route(async () => ({ success: true, friends: await client.getAllFriends() })));
app.get(
  "/find-user",
  route(async (_b, req) => {
    if (!req.query.phone) throw badRequest("phone required");
    return { success: true, user: await client.findUser(req.query.phone) };
  }),
);

// ── Groups ────────────────────────────────────────────────────────────────
app.get("/groups", route(async () => ({ success: true, groups: await client.getAllGroups() })));
// Friendly id+name list of groups and friends, for the setup wizard.
app.get("/contacts", route(async () => ({ success: true, ...(await client.listContacts()) })));
app.post(
  "/group/create",
  route(async (b) => {
    requireMembers(b, false);
    return ok(await client.createGroup(b.name, b.members));
  }),
);
app.post(
  "/group/add",
  route(async (b) => {
    requireMembers(b);
    return ok(await client.addUserToGroup(b.groupId, b.members));
  }),
);
app.post(
  "/group/remove",
  route(async (b) => {
    requireMembers(b);
    return ok(await client.removeUserFromGroup(b.groupId, b.members));
  }),
);
app.post(
  "/group/rename",
  route(async (b) => {
    requireFields(b, "groupId", "name");
    return ok(await client.changeGroupName(b.groupId, b.name));
  }),
);
app.post(
  "/group/deputy",
  route(async (b) => {
    requireMembers(b);
    return ok(await client.addGroupDeputy(b.groupId, b.members));
  }),
);
app.post(
  "/group/leave",
  route(async (b) => {
    requireFields(b, "groupId");
    return ok(await client.leaveGroup(b.groupId, b.silent));
  }),
);

// ── Poll ──────────────────────────────────────────────────────────────────
// Body: { groupId, question, options[], expiredTime?, allowMultiChoices?, ... }
app.post(
  "/poll/create",
  route(async (b) => {
    const { groupId, question, options, ...extra } = b;
    if (!groupId || !question || !Array.isArray(options) || options.length < 2) {
      throw badRequest("groupId, question and options[>=2] required");
    }
    return ok(await client.createPoll(groupId, question, options, extra));
  }),
);

// ── Generic passthrough: call ANY zca-js API method ───────────────────────
// POST /api/<method>  body { args: [...] }
// Covers the full zca-js surface (forwardMessage, deleteMessage, sendVideo,
// getGroupMembersInfo, reminders, mute/pin, profile, business, etc.).
// Pass args positionally exactly as zca-js expects; use "user"/"group" where
// a ThreadType is needed (auto-converted). Gated by the policy middleware.
app.post(
  "/api/:method",
  route(async (b, req) => {
    const result = await client.callRaw(req.params.method, b.args || []);
    return { success: true, result: result ?? null };
  }),
);

// ── Lifecycle ─────────────────────────────────────────────────────────────
let _httpServer = null;
let _shuttingDown = false;

async function main() {
  // Bind first: if the port is taken (another bridge already running) we must
  // exit before opening a second Zalo connection, which would kick the first.
  await new Promise((resolve) => {
    _httpServer = app.listen(PORT, HOST, resolve);
    _httpServer.on("error", (e) => {
      if (e.code === "EADDRINUSE") {
        console.error(`[bridge] port ${HOST}:${PORT} is already in use — is another bridge running?`);
      } else {
        console.error("[bridge] HTTP server error:", errMessage(e));
      }
      process.exit(1);
    });
  });
  console.log(`[bridge] listening on http://${HOST}:${PORT}`);
  if (!TOKEN) console.log("[bridge] WARNING: no ZALO_PLUGIN_TOKEN set (loopback only recommended)");

  try {
    const result = await client.login({ forceQR: FORCE_QR });
    console.log(`[bridge] login complete via ${result.method}`);
  } catch (e) {
    console.error("[bridge] login failed:", errMessage(e));
    console.error("[bridge] server stays up; call /qr to retry login state.");
  }
}

async function gracefulShutdown(reason) {
  if (_shuttingDown) return;
  _shuttingDown = true;
  console.log(`[bridge] graceful shutdown (${reason})…`);
  // Close SSE clients so consumers see the stream end.
  for (const res of sseClients) {
    try {
      res.end();
    } catch {
      /* ignore */
    }
  }
  sseClients.clear();
  try {
    await client.shutdown();
  } catch {
    /* ignore */
  }
  if (_httpServer) {
    _httpServer.close(() => process.exit(0));
    // Hard exit if close hangs.
    setTimeout(() => process.exit(0), 3000).unref();
  } else {
    process.exit(0);
  }
}

process.on("SIGTERM", () => gracefulShutdown("SIGTERM"));
process.on("SIGINT", () => gracefulShutdown("SIGINT"));

main();
