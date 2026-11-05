// install.mjs — one-shot, cross-platform installer for the Hermes Zalo plugin.
// Runs the same on macOS, Linux, and Windows (Node drives everything; only the
// service-manager step branches per-OS).
//
//   node install.mjs                 # full setup: deps → login → background service
//   node install.mjs --no-service    # deps → login only (run `npm start` yourself)
//   node install.mjs --relogin       # force a fresh QR login
//   node install.mjs --service-only  # (re)install just the background service
//   node install.mjs --profile <name> # install the adapter into this Hermes profile
//                                    # (~/.hermes/profiles/<name>; "default" = ~/.hermes)
//   node install.mjs --hermes-home <dir>  # advanced: an explicit Hermes home directory
//   node install.mjs --with-hook     # also install the tool-access hook
//   node install.mjs --hook-owner <uid> [--hook-mode read|full-dm|full]
//                                    # hook + owner settings in the profile .env
//
// After this, the end-user only needs:  hermes gateway setup  → choose Zalo.

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { dataDir, hermesHomeSourceLabel, logDir, resolveHermesHome } from "./paths.js";
import { restartService, serviceInstalled, stopService } from "./service.js";
import {
  HOOK_FILE, addPreToolHook, enablePlatformToolsets, readProvidedToolsets, setEnvVar,
} from "./hermesConfig.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const argv = process.argv.slice(2);
const has = (f) => argv.includes(f);
const NO_SERVICE = has("--no-service");
const RELOGIN = has("--relogin") || has("--force");
const SERVICE_ONLY = has("--service-only");
// `--name value` or `--name=value`; undefined when absent.
function flag(name) {
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === name) {
      const v = argv[i + 1];
      if (v == null || v.startsWith("-")) die(`${name} requires a value`);
      return v;
    }
    if (argv[i].startsWith(`${name}=`)) return argv[i].slice(name.length + 1);
  }
  return undefined;
}
const HOOK_OWNER = flag("--hook-owner");
const HOOK_MODE = flag("--hook-mode");
const WITH_HOOK = has("--with-hook") || HOOK_OWNER != null || HOOK_MODE != null;
if (HOOK_OWNER != null && !/^\d+(,\d+)*$/.test(HOOK_OWNER.replace(/\s/g, ""))) {
  die("--hook-owner takes Zalo uid(s): digits, comma-separated");
}
if (HOOK_MODE != null && !["read", "full-dm", "full"].includes(HOOK_MODE)) {
  die("--hook-mode must be read, full-dm or full");
}

const PLATFORM = process.platform; // 'darwin' | 'linux' | 'win32'

// Where the Hermes adapter goes. Resolved up front so a typo in --profile
// fails before the QR login and service steps.
let HERMES_HOME_TARGET;
try {
  HERMES_HOME_TARGET = resolveHermesHome(argv);
} catch (e) {
  die(e.message);
}
// A named profile is created by Hermes (it seeds config, .env, skills…); a
// missing one is almost always a typo, so stop instead of inventing it.
if ((HERMES_HOME_TARGET.source === "profile" || HERMES_HOME_TARGET.source === "env-profile")
    && HERMES_HOME_TARGET.profile !== "default" && !fs.existsSync(HERMES_HOME_TARGET.dir)) {
  const p = HERMES_HOME_TARGET.profile;
  die(`Hermes profile '${p}' not found at ${HERMES_HOME_TARGET.dir}.\n` +
    `  Create it first:  hermes profile create ${p}\n` +
    "  (list existing ones with: hermes profile list)");
}

// The service must outlive Node upgrades. process.execPath often points into a
// versioned directory that the package manager deletes on the next update
// (snap: /snap/node/<rev>/…, Homebrew: …/Cellar/node/<ver>/…), after which
// the service fails to start (systemd status=203/EXEC). Use the stable alias.
function stableNodeBin(exe = process.execPath) {
  const snap = exe.match(/^\/snap\/([^/]+)\/x?\d+\/(.+)$/);
  if (snap) {
    const current = `/snap/${snap[1]}/current/${snap[2]}`;
    if (fs.existsSync(current)) return current;
  }
  const brew = exe.match(/^(.*)\/Cellar\/node(?:@[^/]+)?\/[^/]+\/bin\/node$/);
  if (brew) {
    const linked = `${brew[1]}/bin/node`;
    if (fs.existsSync(linked)) return linked;
  }
  return exe;
}
const NODE_BIN = stableNodeBin();
const SERVER_JS = path.join(__dirname, "server.js");
const LABEL = "com.hermes.zaloplugin";

// Data-location overrides the user ran setup with. The service manager starts
// the bridge with a clean environment, so without these it would look for
// credentials/bridge.env in the default ~/.hermes-zalo and miss the login.
const PATH_ENV_KEYS = [
  "ZALO_DATA_DIR", "ZALO_BRIDGE_ENV", "ZALO_CREDENTIALS_PATH",
  "ZALO_QR_PATH", "ZALO_CLIMSG_DIR", "ZALO_LOG_DIR",
];
function serviceEnv() {
  const out = {};
  for (const k of PATH_ENV_KEYS) {
    const v = (process.env[k] || "").trim();
    if (v) out[k] = path.resolve(v);
  }
  return out;
}
const xmlEscape = (v) => v.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

function log(msg) { console.log(msg); }
function step(n, msg) { console.log(`\n[${n}] ${msg}`); }
function die(msg) { console.error(`\n✗ ${msg}`); process.exit(1); }

function run(cmd, args, opts = {}) {
  const r = spawnSync(cmd, args, { stdio: "inherit", cwd: __dirname, ...opts });
  if (r.status !== 0) die(`command failed: ${cmd} ${args.join(" ")}`);
  return r;
}

// ── 0. Prerequisites ────────────────────────────────────────────────────────
function checkPrereqs() {
  // Node version
  const major = parseInt(process.versions.node.split(".")[0], 10);
  if (major < 18) {
    die(
      `Node >= 18 required (found ${process.version}).\n` +
      `  Install Node:\n` +
      `    macOS:    brew install node   (or https://nodejs.org)\n` +
      `    Linux:    use nvm (https://github.com/nvm-sh/nvm) or your distro's nodejs package\n` +
      `    Windows:  https://nodejs.org (LTS installer)`
    );
  }
  log(`✓ Node ${process.version}`);

  // npm must be on PATH (it ships with Node, but some minimal installs strip it)
  const npmCmd = PLATFORM === "win32" ? "npm.cmd" : "npm";
  const probe = spawnSync(npmCmd, ["--version"], { stdio: "ignore", shell: PLATFORM === "win32" });
  if (probe.status !== 0) {
    die(
      "npm not found on PATH. It normally ships with Node.js.\n" +
      "  Reinstall Node from https://nodejs.org, or ensure npm is on your PATH."
    );
  }
  log("✓ npm available");
}

// ── 1. Install dependencies (pulls zca-js from npm — no build, no bun) ───────
function installDeps() {
  // When installed as an npm package (global or npx), deps are already present —
  // skip. Only run `npm install` from a source checkout missing node_modules.
  const haveDeps = fs.existsSync(path.join(__dirname, "node_modules", "zca-js"));
  if (haveDeps) {
    log("✓ Dependencies already present (skipping npm install)");
    return;
  }
  step(1, "Installing dependencies (npm install)…");
  // npm is cross-platform; on Windows the shell needs npm.cmd via shell:true.
  run(PLATFORM === "win32" ? "npm.cmd" : "npm", ["install", "--no-audit", "--no-fund"], {
    shell: PLATFORM === "win32",
  });
  log("✓ Dependencies installed");
}

// ── 2. Log in (QR) unless we already have working credentials ────────────────
function login({ restartOnFailure = false } = {}) {
  step(2, "Zalo login…");
  const args = [path.join(__dirname, "login.mjs")];
  if (RELOGIN) args.push("--force");
  const r = spawnSync(NODE_BIN, args, {
    stdio: "inherit",
    cwd: __dirname,
    env: { ...process.env, HZP_FROM_SETUP: !NO_SERVICE || restartOnFailure ? "1" : "" },
  });
  if (r.status !== 0) {
    // Don't leave the user with no bridge at all: bring the old one back.
    if (restartOnFailure) restartService();
    die("Zalo login failed (see above). Re-run: hermes-zalo-plugin setup --relogin");
  }
}

// ── 3. Background service (per-OS) ───────────────────────────────────────────
function installServiceDarwin() {
  const plistDir = path.join(os.homedir(), "Library", "LaunchAgents");
  fs.mkdirSync(plistDir, { recursive: true });
  const plistPath = path.join(plistDir, `${LABEL}.plist`);
  const logs = logDir();
  fs.mkdirSync(logs, { recursive: true });
  const env = Object.entries(serviceEnv());
  const envXml = env.length
    ? `  <key>EnvironmentVariables</key>
  <dict>
${env.map(([k, v]) => `    <key>${k}</key><string>${xmlEscape(v)}</string>`).join("\n")}
  </dict>
`
    : "";
  const plist = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>${LABEL}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${NODE_BIN}</string>
    <string>${SERVER_JS}</string>
  </array>
  <key>WorkingDirectory</key><string>${__dirname}</string>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
${envXml}  <key>StandardOutPath</key><string>${path.join(logs, "bridge.out.log")}</string>
  <key>StandardErrorPath</key><string>${path.join(logs, "bridge.err.log")}</string>
</dict>
</plist>
`;
  fs.writeFileSync(plistPath, plist);
  // reload (ignore failures if not yet loaded)
  spawnSync("launchctl", ["unload", plistPath], { stdio: "ignore" });
  // `load` starts it (RunAtLoad); after a package update this also picks up new code.
  run("launchctl", ["load", plistPath]);
  log(`✓ launchd service installed: ${plistPath}`);
  log("  Manage: launchctl unload/load the plist above.");
}

function installServiceLinux() {
  const unitDir = path.join(os.homedir(), ".config", "systemd", "user");
  fs.mkdirSync(unitDir, { recursive: true });
  const unitPath = path.join(unitDir, `${LABEL}.service`);
  const unit = `[Unit]
Description=Hermes Zalo Plugin
After=network-online.target

[Service]
Type=simple
WorkingDirectory=${__dirname}
${Object.entries(serviceEnv()).map(([k, v]) => `Environment="${k}=${v}"\n`).join("")}ExecStart=${NODE_BIN} ${SERVER_JS}
Restart=always
RestartSec=5

[Install]
WantedBy=default.target
`;
  fs.writeFileSync(unitPath, unit);
  const sysctl = (args) => spawnSync("systemctl", ["--user", ...args], { stdio: "inherit" });
  if (spawnSync("systemctl", ["--version"], { stdio: "ignore" }).status !== 0) {
    log(`⚠ systemd not available. Unit written to ${unitPath}; start the bridge manually with: npm start`);
    return;
  }
  sysctl(["daemon-reload"]);
  // enable + restart (not `enable --now`): on a re-run after a package update
  // an already-running bridge must be restarted to load the new code.
  const ok = sysctl(["enable", `${LABEL}.service`]).status === 0
    && sysctl(["restart", `${LABEL}.service`]).status === 0;
  if (!ok) {
    log(`⚠ Unit written to ${unitPath}, but systemd --user could not start it.`);
    log("  (Common over SSH without a user session: run `loginctl enable-linger $USER` and re-login.)");
    log("  Start the bridge manually meanwhile: hermes-zalo-plugin start");
    return;
  }
  log(`✓ systemd user service installed & started: ${unitPath}`);
  log(`  Manage: systemctl --user status/restart/stop ${LABEL}`);
  log("  Tip: run `loginctl enable-linger $USER` so it runs without an active login session.");
}

function installServiceWindows() {
  // Scheduled Task that runs at logon (no auto-restart on crash). Avoids needing
  // nssm/admin service install. Uses schtasks (present on all Windows).
  const taskName = "HermesZaloPlugin";
  // A tiny launcher sets cwd + data-location env and captures logs (schtasks
  // /TR has none of that and a ~260 char limit).
  const logs = logDir();
  fs.mkdirSync(logs, { recursive: true });
  const launcher = path.join(dataDir(), "bridge-launcher.cmd");
  const envLines = Object.entries(serviceEnv()).map(([k, v]) => `set "${k}=${v}"`);
  fs.writeFileSync(launcher, [
    "@echo off",
    `cd /d "${__dirname}"`,
    ...envLines,
    `"${NODE_BIN}" "${SERVER_JS}" >> "${path.join(logs, "bridge.out.log")}" 2>> "${path.join(logs, "bridge.err.log")}"`,
    "",
  ].join("\r\n"));
  const cmd = `"${launcher}"`;
  const args = [
    "/Create", "/F",
    "/SC", "ONLOGON",
    "/TN", taskName,
    "/TR", cmd,
    "/RL", "LIMITED",
  ];
  const r = spawnSync("schtasks", args, { stdio: "inherit", shell: true });
  if (r.status !== 0) {
    log("⚠ Could not register a Scheduled Task automatically. Start the bridge manually with: npm start");
    log("  Or create a task that runs at logon with command:");
    log(`    ${cmd}`);
    return;
  }
  log(`✓ Scheduled Task '${taskName}' registered (runs at logon).`);
  // Start it now too, otherwise the bridge is down until the next logon.
  spawnSync("schtasks", ["/End", "/TN", taskName], { stdio: "ignore", shell: true });
  if (spawnSync("schtasks", ["/Run", "/TN", taskName], { stdio: "ignore", shell: true }).status === 0) {
    log("✓ Bridge started.");
  } else {
    log(`⚠ Could not start it now. Run:  schtasks /Run /TN ${taskName}`);
  }
  log(`  Manage:     Task Scheduler → ${taskName}`);
}

function installService() {
  step(3, "Installing background service (auto-start + auto-restart)…");
  if (PLATFORM === "darwin") return installServiceDarwin();
  if (PLATFORM === "linux") return installServiceLinux();
  if (PLATFORM === "win32") return installServiceWindows();
  log(`⚠ Unsupported platform '${PLATFORM}' for auto-service. Run the bridge manually: npm start`);
}

// ── 4. Install the Hermes-side plugin so `hermes gateway` sees Zalo ──────────
// The bridge (Node) and the Hermes adapter (Python) are separate halves. The
// adapter lives under hermes-plugin/ in this package; copy it into the user's
// Hermes plugin dir (<hermes home>/plugins/zalo) and add "zalo" to plugins.enabled
// so the (untrusted) user plugin is allowed to load.
function installHermesPlugin() {
  step(4, "Installing the Hermes plugin (so `hermes gateway` sees Zalo)…");
  const src = path.join(__dirname, "hermes-plugin");
  if (!fs.existsSync(src)) {
    log("⚠ hermes-plugin/ not found in package — skipping (bridge still works standalone).");
    return;
  }
  const home = HERMES_HOME_TARGET;
  const hermesHome = home.dir;
  log(`Hermes profile: ${home.profile ?? "(custom)"} → ${hermesHome} (${hermesHomeSourceLabel(home)})`);
  if (!fs.existsSync(hermesHome)) {
    // Never create the default home: Hermes may simply not be installed yet.
    if (home.source === "default") {
      log(`⚠ Hermes home not found at ${hermesHome}.`);
      log("  Skipping plugin install. Pass --profile <name> for a named Hermes profile,");
      log("  or install Hermes and re-run: npx hermes-zalo-plugin setup --service-only");
      return;
    }
    fs.mkdirSync(hermesHome, { recursive: true });
  }
  const dest = path.join(hermesHome, "plugins", "zalo");
  fs.mkdirSync(dest, { recursive: true });
  // Files only: a checkout has hermes-plugin/__pycache__/, and copyFileSync on
  // a directory throws EISDIR. Python rebuilds bytecode itself.
  for (const ent of fs.readdirSync(src, { withFileTypes: true })) {
    if (!ent.isFile() || ent.name.endsWith(".pyc")) continue;
    fs.copyFileSync(path.join(src, ent.name), path.join(dest, ent.name));
  }
  // Drop bytecode left by an older adapter version.
  fs.rmSync(path.join(dest, "__pycache__"), { recursive: true, force: true });
  log(`✓ Plugin copied to ${dest}`);

  // Enable the plugin in config.yaml (plugins.enabled must contain "zalo").
  const cfgPath = path.join(hermesHome, "config.yaml");
  try {
    const enabled = enableZaloInConfig(cfgPath);
    log(enabled === "already" ? "✓ Plugin already enabled in config.yaml"
        : enabled === "added" ? '✓ Added "zalo-platform" to plugins.enabled in config.yaml'
        : '✓ Created plugins.enabled with "zalo-platform" in config.yaml');
  } catch (e) {
    log(`⚠ Could not auto-enable the plugin: ${e.message}`);
    log(`  Manually add "zalo-platform" under plugins.enabled in ${cfgPath}`);
  }
  enablePluginToolsets(cfgPath, path.join(src, "plugin.yaml"));
  installToolAccessHook(home, cfgPath);
}

// ── 5. Optional pre_tool_call hook limiting what Zalo users can make the agent do ─
// Opt-in (--with-hook / --hook-owner / --hook-mode): with no owner set it blocks
// every tool for Zalo users. Once installed, re-runs keep it up to date.
function installToolAccessHook({ dir: hermesHome, profile }, cfgPath) {
  const src = path.join(__dirname, "hooks", HOOK_FILE);
  const dest = path.join(hermesHome, "agent-hooks", HOOK_FILE);
  const installed = fs.existsSync(dest);
  if (!WITH_HOOK && !installed) {
    log("• Tool access hook not installed (optional: re-run with --with-hook).");
    return;
  }
  if (!fs.existsSync(src)) {
    log(`⚠ hooks/${HOOK_FILE} not found in package — skipping the tool access hook.`);
    return;
  }
  step(5, installed ? "Updating the tool access hook…" : "Installing the tool access hook…");
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.mkdirSync(path.join(hermesHome, "logs"), { recursive: true });
  fs.copyFileSync(src, dest);
  if (PLATFORM !== "win32") fs.chmodSync(dest, 0o700);
  log(`✓ Hook copied to ${dest}`);

  const command = PLATFORM === "win32" ? `python "${dest}"` : dest;
  let status;
  try {
    const before = fs.existsSync(cfgPath) ? fs.readFileSync(cfgPath, "utf-8") : "";
    const r = addPreToolHook(before, command);
    status = r.status;
    if (status !== "already") fs.writeFileSync(cfgPath, r.text);
    log(status === "already" ? "✓ Hook already registered in config.yaml"
        : status === "updated" ? "✓ Updated the hook command in config.yaml"
        : "✓ Registered the hook under hooks.pre_tool_call in config.yaml");
  } catch (e) {
    log(`⚠ Could not register the hook: ${e.message}`);
    log(`  Add under hooks.pre_tool_call in ${cfgPath}:`);
    log(`    - command: ${JSON.stringify(command)}\n      timeout: 10\n      fail_closed: true`);
  }

  const envPath = path.join(hermesHome, ".env");
  let envText = fs.existsSync(envPath) ? fs.readFileSync(envPath, "utf-8") : "";
  const settings = [
    ["ZALO_HOOK_OWNERS", HOOK_OWNER?.replace(/\s/g, "")],
    ["ZALO_HOOK_OWNER_MODE", HOOK_MODE],
  ];
  let changed = false;
  for (const [key, value] of settings) {
    if (value == null) continue;
    const r = setEnvVar(envText, key, value);
    envText = r.text;
    changed ||= r.changed;
    log(`✓ ${key}=${value} in ${envPath}`);
  }
  if (changed) fs.writeFileSync(envPath, envText, { mode: 0o600 });
  if (!/^\s*ZALO_HOOK_OWNERS=\S/m.test(envText)) {
    log("⚠ No ZALO_HOOK_OWNERS set: every Zalo user is blocked from all tools.");
    log("  Set one with --hook-owner <uid> (ZALO_LOG_IDS=true logs uids).");
  }

  if (status === "added" || status === "updated") {
    log("  Hermes runs a new or changed hook only after you approve it:");
    log(`    hermes ${profile && profile !== "default" ? `-p ${profile} ` : ""}--accept-hooks   (or HERMES_ACCEPT_HOOKS=1)`);
    log("  then restart the gateway.");
  }
}

// Turn on every toolset the plugin provides (plugin.yaml provides_toolsets)
// for the zalo platform. Hermes enables plugin toolsets by default, but once a
// platform has a saved toolset list (`hermes tools`) only the listed ones run.
function enablePluginToolsets(cfgPath, pluginYamlPath) {
  let toolsets = [];
  try {
    toolsets = readProvidedToolsets(fs.readFileSync(pluginYamlPath, "utf-8"));
  } catch {
    return;
  }
  if (!toolsets.length) return;
  try {
    const before = fs.existsSync(cfgPath) ? fs.readFileSync(cfgPath, "utf-8") : "";
    const r = enablePlatformToolsets(before, "zalo", toolsets);
    if (r.status === "added") {
      fs.writeFileSync(cfgPath, r.text);
      log(`✓ Enabled toolset(s) for Zalo in config.yaml: ${r.added.join(", ")}`);
    } else if (r.status === "already") {
      log(`✓ Toolset(s) already enabled for Zalo: ${toolsets.join(", ")}`);
    } else {
      log(`✓ Toolset(s) ${toolsets.join(", ")} on by default (no saved Zalo toolset list)`);
    }
  } catch (e) {
    log(`⚠ Could not enable the plugin toolsets: ${e.message}`);
    log(`  Add ${toolsets.join(", ")} under platform_toolsets.zalo in ${cfgPath}`);
  }
}

// Minimal, robust YAML editor for the one thing we need: ensure
// plugins.enabled contains "zalo". Operates line-by-line to avoid a YAML dep.
// Returns "already" | "added" | "created".
function enableZaloInConfig(cfgPath) {
  const text = fs.existsSync(cfgPath) ? fs.readFileSync(cfgPath, "utf-8") : "";
  const lines = text.split("\n");

  // Find a top-level "plugins:" line (no leading whitespace).
  let pluginsIdx = lines.findIndex((l) => /^plugins:\s*$/.test(l));
  if (pluginsIdx === -1) {
    // No plugins block — append a fresh one.
    const sep = text.length && !text.endsWith("\n") ? "\n" : "";
    fs.writeFileSync(cfgPath, text + sep + "\nplugins:\n  enabled:\n    - zalo-platform\n");
    return "created";
  }

  // Within the plugins block, find "enabled:" (2-space indent).
  let i = pluginsIdx + 1;
  let enabledIdx = -1;
  for (; i < lines.length; i++) {
    if (/^\S/.test(lines[i]) && lines[i].trim() !== "") break; // left the block
    if (/^\s+enabled:/.test(lines[i])) { enabledIdx = i; break; }
  }

  if (enabledIdx === -1) {
    // plugins: exists but no enabled: — insert one right after plugins:.
    lines.splice(pluginsIdx + 1, 0, "  enabled:", "    - zalo-platform");
    fs.writeFileSync(cfgPath, lines.join("\n"));
    return "added";
  }

  // enabled: may be inline ([a, b]) or a block list. Scan following list items.
  const inline = lines[enabledIdx].match(/enabled:\s*\[(.*)\]/);
  if (inline) {
    if (/(^|[,\s])zalo-platform([,\s]|$)/.test(inline[1])) return "already";
    const items = inline[1].trim();
    lines[enabledIdx] = lines[enabledIdx].replace(
      /enabled:\s*\[.*\]/,
      `enabled: [${items ? items + ", " : ""}zalo-platform]`,
    );
    fs.writeFileSync(cfgPath, lines.join("\n"));
    return "added";
  }

  // Block list: check the indented "- " items below enabled:. Track the last
  // real list item so we insert right after it (not after trailing blanks).
  let lastItem = enabledIdx;
  for (let j = enabledIdx + 1; j < lines.length; j++) {
    if (/^\s*-\s*zalo-platform\s*$/.test(lines[j])) return "already";
    if (/^\s*-\s/.test(lines[j])) { lastItem = j; continue; }
    if (lines[j].trim() === "") continue; // skip blank lines within/after the list
    break; // a non-list, non-blank line ends the list
  }
  lines.splice(lastItem + 1, 0, "    - zalo-platform");
  fs.writeFileSync(cfgPath, lines.join("\n"));
  return "added";
}

function nextSteps() {
  const port = process.env.ZALO_PLUGIN_PORT || "8787";
  console.log(`
────────────────────────────────────────────────────────
✓ Zalo plugin is set up.

  Bridge URL:  http://127.0.0.1:${port}
  Health:      curl http://127.0.0.1:${port}/health

Next, register Zalo in Hermes:
  1) hermes gateway setup     → choose "Zalo" (🇻🇳)
  2) hermes gateway           → start relaying

The background service keeps the bridge running and restarts it on crash
or reboot, so you only do the login + setup once.
────────────────────────────────────────────────────────
`);
}

function banner() {
  // ANSI colors only when stdout is a TTY (avoid junk in logs/pipes).
  const tty = process.stdout.isTTY;
  const c = (code, s) => (tty ? `\x1b[${code}m${s}\x1b[0m` : s);
  const blue = (s) => c("38;5;33", s);   // Zalo blue
  const cyan = (s) => c("36", s);
  const dim = (s) => c("2", s);
  console.log(
    "\n" +
    blue("  ╦ ╦┌─┐┬─┐┌┬┐┌─┐┌─┐  ") + cyan("╔═╗┌─┐┬  ┌─┐") + "\n" +
    blue("  ╠═╣├┤ ├┬┘│││├┤ └─┐  ") + cyan("╔═╝├─┤│  │ │") + "\n" +
    blue("  ╩ ╩└─┘┴└─┴ ┴└─┘└─┘  ") + cyan("╚═╝┴ ┴┴─┘└─┘") + "\n" +
    dim("  Hermes × Zalo plugin") + "\n" +
    dim("  chat with your Hermes agent from Zalo") + "\n",
  );
}

async function main() {
  banner();
  console.log("Hermes Zalo Plugin — installer");
  console.log("(Safe to re-run: deps are upserted, login is skipped if already logged in,");
  console.log(" and the background service is re-registered cleanly.)\n");
  checkPrereqs();

  if (SERVICE_ONLY) {
    installService();
    installHermesPlugin();
    nextSteps();
    return;
  }

  installDeps();
  // --relogin while the service is running: login.mjs refuses (a second Zalo
  // connection would kick the live one), so stop the service first. The
  // service step below starts it again with the new session.
  let stoppedForLogin = false;
  if (RELOGIN && serviceInstalled()) {
    log("\nStopping the running bridge service so the QR login does not collide with it…");
    stoppedForLogin = stopService().ok;
  }
  login({ restartOnFailure: stoppedForLogin });
  if (!NO_SERVICE) installService();
  else if (stoppedForLogin) {
    const r = restartService();
    log(r.ok ? "✓ Bridge service started again with the new session." : `⚠ Could not restart the service: ${r.message}`);
  }
  else log("\n(Skipping background service — run `npm start` to launch the bridge.)");
  installHermesPlugin();
  nextSteps();
}

main().catch((e) => die(e?.message || String(e)));
