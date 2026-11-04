// paths.js — central resolution of where the bridge stores its data.
//
// When installed globally (npm i -g), the package directory is read-only and
// gets wiped on update, so credentials/QR/cache MUST live in the user's home,
// not next to the code. Resolution order:
//   1) explicit env (ZALO_DATA_DIR, or per-file ZALO_CREDENTIALS_PATH/ZALO_QR_PATH)
//   2) ~/.hermes-zalo/   (default for global/CLI installs)
//
// A local dev checkout can opt back into ./data by setting
// ZALO_DATA_DIR=./data (or running with that env), keeping old behaviour.

import os from "node:os";
import path from "node:path";
import fs from "node:fs";

export function dataDir() {
  const fromEnv = process.env.ZALO_DATA_DIR;
  const dir = fromEnv && fromEnv.trim()
    ? path.resolve(fromEnv.trim())
    : path.join(os.homedir(), ".hermes-zalo");
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  return dir;
}

// Secrets (session cookie, login QR) must be readable by the owner only.
// writeFileSync's `mode` applies only when the file is created, so chmod too
// to tighten a file left group/world-readable by an older version. chmod is a
// no-op on Windows, where the user profile ACL already protects the file.
export function restrictToOwner(file) {
  try {
    if ((fs.statSync(file).mode & 0o077) !== 0) fs.chmodSync(file, 0o600);
  } catch {
    /* missing file or unsupported FS: nothing to tighten */
  }
}

export function writePrivateFile(file, data, encoding = "utf-8") {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  fs.writeFileSync(file, data, { encoding, mode: 0o600 });
  restrictToOwner(file);
}

export function credentialsPath() {
  return process.env.ZALO_CREDENTIALS_PATH || path.join(dataDir(), "credentials.json");
}

export function qrPath() {
  return process.env.ZALO_QR_PATH || path.join(dataDir(), "qr.png");
}

export function cliMsgDir() {
  return process.env.ZALO_CLIMSG_DIR || path.join(dataDir(), "climsgids");
}

export function logDir() {
  return process.env.ZALO_LOG_DIR || dataDir();
}

// Bridge-side settings file. The bridge runs as a background service
// (systemd/launchd/Scheduled Task) and never sees the Hermes profile's .env,
// so `hermes gateway setup` mirrors the bridge-side keys (token, action policy,
// cache tuning) here. Real environment variables always win over the file.
export function bridgeEnvPath() {
  return process.env.ZALO_BRIDGE_ENV || path.join(dataDir(), "bridge.env");
}

/** Parse KEY=VALUE lines (blank lines, `#` comments and `export ` allowed). */
export function parseEnvFile(text) {
  const out = {};
  for (const raw of String(text || "").split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const m = line.match(/^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/);
    if (!m) continue;
    let value = m[2].trim();
    if (value.length >= 2 && (value[0] === '"' || value[0] === "'") && value.at(-1) === value[0]) {
      value = value.slice(1, -1);
    }
    out[m[1]] = value;
  }
  return out;
}

/**
 * Load bridge.env into process.env without overriding variables that are
 * already set. Returns { file, applied: [keys] }. Missing file is not an error.
 */
export function loadBridgeEnv() {
  const file = bridgeEnvPath();
  const applied = [];
  try {
    if (!fs.existsSync(file)) return { file, applied };
    const vars = parseEnvFile(fs.readFileSync(file, "utf-8"));
    for (const [k, v] of Object.entries(vars)) {
      if (process.env[k] === undefined) {
        process.env[k] = v;
        applied.push(k);
      }
    }
  } catch (e) {
    console.error(`[bridge] could not read ${file}: ${e.message}`);
  }
  return { file, applied };
}

function flagValue(argv, name) {
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === name) {
      const next = argv[i + 1];
      if (next == null || next.startsWith("-")) {
        throw new Error(`${name} requires a path`);
      }
      return next;
    }
    if (a.startsWith(`${name}=`)) {
      const value = a.slice(name.length + 1);
      if (!value) throw new Error(`${name} requires a path`);
      return value;
    }
  }
  return undefined;
}

function expandUserPath(p) {
  if (p === "~") return os.homedir();
  if (p.startsWith("~/") || p.startsWith("~\\")) return path.resolve(path.join(os.homedir(), p.slice(2)));
  return path.resolve(p);
}

// Hermes profile the Python adapter is copied into.
//   1) --hermes-home <path>   (setup / uninstall)
//   2) HERMES_HOME
//   3) ~/.hermes              (only used when it already exists; never created)
// Returns { dir, source: "flag" | "env" | "default" }.
export function resolveHermesHome(argv = []) {
  const flagged = flagValue(argv, "--hermes-home");
  if (flagged != null) return { dir: expandUserPath(flagged), source: "flag" };
  const env = (process.env.HERMES_HOME || "").trim();
  if (env) return { dir: expandUserPath(env), source: "env" };
  return { dir: path.join(os.homedir(), ".hermes"), source: "default" };
}
