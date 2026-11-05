// groupLog.js
// Local log of group messages the account receives, so the agent can report
// group activity and summarise a group. zca-js getGroupChatHistory returns 404
// from Zalo, and in "mention" mode the agent never sees unaddressed messages,
// so the bridge (which hears every message) keeps its own record.
//
// Daily-rotated JSONL files under <dir>, owner-only, kept `retentionDays`
// (0 = memory only, last day). The last `retentionDays` are reloaded on
// startup. prune() deletes older files and forgets older messages in memory;
// it runs at load, on each day rotation and hourly (startPruning).

import fs from "node:fs";
import path from "node:path";

const DAY_MS = 86_400_000;
const PRUNE_EVERY_MS = 3_600_000;
const FILE_RE = /^group-messages-(\d{4}-\d{2}-\d{2})\.jsonl$/;

export class GroupLog {
  /**
   * @param {object} opts
   * @param {string} opts.dir             where the JSONL files live
   * @param {number} [opts.retentionDays] days kept on disk and in memory (0 = memory only, 1 day)
   * @param {number} [opts.maxPerGroup]   newest messages kept in memory per group
   * @param {number} [opts.maxTextChars]  longer texts are cut
   */
  constructor({ dir, retentionDays = 3, maxPerGroup = 3000, maxTextChars = 2000 }) {
    this.dir = dir;
    this.persist = Number.isFinite(retentionDays) && retentionDays > 0;
    this.retentionMs = (this.persist ? retentionDays : 1) * DAY_MS;
    this.maxPerGroup = maxPerGroup;
    this.maxTextChars = maxTextChars;
    this.groups = new Map(); // groupId -> [{t, u, n, x, k, s}] oldest first
    this._stream = null;
    this._streamDay = null;
    this._seen = new Set(); // msgIds already recorded (listener can echo twice)
    this._pruneTimer = null;
  }

  _day(ms = Date.now()) {
    return new Date(ms).toISOString().slice(0, 10);
  }

  _push(groupId, rec) {
    let list = this.groups.get(groupId);
    if (!list) this.groups.set(groupId, (list = []));
    list.push(rec);
    if (list.length > this.maxPerGroup) list.splice(0, list.length - this.maxPerGroup);
  }

  /** Record one normalised group message event (see ZaloClient._normaliseMessage). */
  record(ev) {
    if (!ev || ev.threadType !== "group") return;
    const id = String(ev.messageId || "");
    if (id) {
      if (this._seen.has(id)) return;
      this._seen.add(id);
      if (this._seen.size > 20000) this._seen = new Set([...this._seen].slice(-10000));
    }
    const rec = {
      id,
      t: Number(ev.ts) || Date.now(),
      u: String(ev.senderId || ""),
      n: String(ev.senderName || ""),
      x: String(ev.text || "").slice(0, this.maxTextChars),
      k: String(ev.msgType || ""),
      s: ev.isSelf ? 1 : 0,
    };
    const groupId = String(ev.threadId);
    this._push(groupId, rec);
    if (!this.persist) return;
    try {
      const day = this._day();
      if (!this._stream || this._streamDay !== day) {
        if (this._stream) this._stream.end();
        fs.mkdirSync(this.dir, { recursive: true, mode: 0o700 });
        const file = path.join(this.dir, `group-messages-${day}.jsonl`);
        this._stream = fs.createWriteStream(file, { flags: "a", mode: 0o600 });
        this._streamDay = day;
        this.prune();
      }
      this._stream.write(JSON.stringify({ g: groupId, ...rec }) + "\n");
    } catch (e) {
      console.error("[zalo] group log write failed:", e.message);
    }
  }

  /** Reload the retained files into memory (call once at startup). */
  load() {
    this.prune();
    if (!this.persist || !fs.existsSync(this.dir)) return 0;
    const cutoff = Date.now() - this.retentionMs;
    let n = 0;
    const files = fs.readdirSync(this.dir).filter((f) => FILE_RE.test(f)).sort();
    for (const f of files) {
      if (Date.parse(f.match(FILE_RE)[1] + "T00:00:00Z") + DAY_MS < cutoff) continue;
      for (const line of fs.readFileSync(path.join(this.dir, f), "utf-8").split("\n")) {
        if (!line.trim()) continue;
        try {
          const { g, ...rec } = JSON.parse(line);
          if (!g || rec.t < cutoff || (rec.id && this._seen.has(rec.id))) continue;
          if (rec.id) this._seen.add(rec.id);
          this._push(String(g), rec);
          n++;
        } catch {
          /* skip a corrupt line */
        }
      }
    }
    return n;
  }

  /**
   * Enforce retention: forget messages older than the window and delete day
   * files that end before it. With persistence off, every log file is deleted.
   * Returns { files, messages } removed.
   */
  prune(now = Date.now()) {
    const cutoff = now - this.retentionMs;
    let messages = 0;
    for (const [groupId, list] of this.groups) {
      const keepFrom = list.findIndex((r) => r.t >= cutoff);
      const drop = keepFrom === -1 ? list.length : keepFrom;
      if (drop) {
        list.splice(0, drop);
        messages += drop;
      }
      if (!list.length) this.groups.delete(groupId);
    }
    let files = 0;
    try {
      const cutoffDay = this._day(cutoff);
      for (const f of fs.readdirSync(this.dir)) {
        const m = f.match(FILE_RE);
        if (!m || (this.persist && m[1] >= cutoffDay)) continue;
        if (this.persist && m[1] === this._streamDay) continue; // never the open file
        fs.unlinkSync(path.join(this.dir, f));
        files++;
      }
    } catch {
      /* no log directory yet */
    }
    if (files) console.log(`[zalo] group log: deleted ${files} file(s) older than retention`);
    return { files, messages };
  }

  /** Run prune() every hour until close(). */
  startPruning(everyMs = PRUNE_EVERY_MS) {
    if (this._pruneTimer) return;
    this._pruneTimer = setInterval(() => this.prune(), everyMs);
    if (this._pruneTimer.unref) this._pruneTimer.unref();
  }

  /** Messages of one group newer than `sinceMs`, oldest first, at most the newest `limit`. */
  messages(groupId, { sinceMs = 0, limit = 300 } = {}) {
    const list = (this.groups.get(String(groupId)) || []).filter((r) => r.t >= sinceMs);
    return list.slice(-limit);
  }

  /** Per-group activity since `sinceMs`: message count, distinct senders, top senders, last message time. */
  stats(sinceMs = 0) {
    const out = {};
    for (const [groupId, list] of this.groups) {
      const recent = list.filter((r) => r.t >= sinceMs);
      const bySender = new Map();
      for (const r of recent) {
        const key = r.u || r.n;
        const cur = bySender.get(key) || { id: r.u, name: r.n, count: 0 };
        cur.count++;
        if (r.n) cur.name = r.n;
        bySender.set(key, cur);
      }
      out[groupId] = {
        messages: recent.length,
        senders: bySender.size,
        topSenders: [...bySender.values()].sort((a, b) => b.count - a.count).slice(0, 5),
        lastMessageAt: list.length ? list[list.length - 1].t : null,
      };
    }
    return out;
  }

  /** Timestamp of the oldest message held, or null. */
  oldest() {
    let min = null;
    for (const list of this.groups.values()) if (list.length && (min === null || list[0].t < min)) min = list[0].t;
    return min;
  }

  /** Flush and close the current file; resolves once it is written. */
  close() {
    if (this._pruneTimer) clearInterval(this._pruneTimer);
    this._pruneTimer = null;
    const stream = this._stream;
    this._stream = null;
    return stream ? new Promise((resolve) => stream.end(resolve)) : Promise.resolve();
  }
}
