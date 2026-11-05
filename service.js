// service.js — shared helpers for the per-OS background service
// (systemd user unit on Linux, launchd agent on macOS, Scheduled Task on Windows).
// Used by bin/cli.mjs (stop/restart/status), install.mjs and uninstall.mjs.

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { dataDir } from "./paths.js";

export const LABEL = "com.hermes.zaloplugin";
export const WIN_TASK = "HermesZaloPlugin";

export const unitPath = () =>
  path.join(os.homedir(), ".config", "systemd", "user", `${LABEL}.service`);
export const plistPath = () =>
  path.join(os.homedir(), "Library", "LaunchAgents", `${LABEL}.plist`);
// Windows: cmd launcher the Scheduled Task runs (sets cwd, env, log redirection).
export const winLauncherPath = () => path.join(dataDir(), "bridge-launcher.cmd");

function quiet(bin, args) {
  return spawnSync(bin, args, { stdio: "ignore", shell: process.platform === "win32" });
}

function loud(bin, args) {
  return spawnSync(bin, args, { stdio: "inherit", shell: process.platform === "win32" });
}

function launchdTarget() {
  const uid = typeof process.getuid === "function" ? process.getuid() : "";
  return `gui/${uid}/${LABEL}`;
}

/** true when the auto-start service is registered on this machine. */
export function serviceInstalled() {
  if (process.platform === "linux") return fs.existsSync(unitPath());
  if (process.platform === "darwin") return fs.existsSync(plistPath());
  if (process.platform === "win32") return quiet("schtasks", ["/Query", "/TN", WIN_TASK]).status === 0;
  return false;
}

/**
 * Stop the running service without unregistering it. It comes back on the
 * next `restart`, and (macOS/Windows) at the next login.
 * Returns { ok, message }.
 */
export function stopService() {
  if (!serviceInstalled()) return { ok: false, message: "background service is not installed" };
  let r;
  if (process.platform === "linux") {
    r = loud("systemctl", ["--user", "stop", `${LABEL}.service`]);
  } else if (process.platform === "darwin") {
    // KeepAlive would respawn a plain `launchctl stop`; unloading really stops it.
    r = quiet("launchctl", ["unload", plistPath()]);
  } else if (process.platform === "win32") {
    // /End fails when the task is not running, which is the state we want.
    quiet("schtasks", ["/End", "/TN", WIN_TASK]);
    return { ok: true, message: "stopped" };
  } else {
    return { ok: false, message: `unsupported platform '${process.platform}'` };
  }
  return r.status === 0 ? { ok: true, message: "stopped" } : { ok: false, message: "service manager refused to stop it" };
}

/**
 * (Re)start the service so it re-reads bridge.env. Starts it when stopped.
 * Returns { ok, message }.
 */
export function restartService() {
  if (!serviceInstalled()) return { ok: false, message: "background service is not installed" };
  let r;
  if (process.platform === "linux") {
    r = loud("systemctl", ["--user", "restart", `${LABEL}.service`]);
  } else if (process.platform === "darwin") {
    r = quiet("launchctl", ["kickstart", "-k", launchdTarget()]);
    if (r.status !== 0) {
      // Not loaded (e.g. after `stop`): load the plist, RunAtLoad starts it.
      r = loud("launchctl", ["load", plistPath()]);
    }
  } else if (process.platform === "win32") {
    quiet("schtasks", ["/End", "/TN", WIN_TASK]);
    r = loud("schtasks", ["/Run", "/TN", WIN_TASK]);
  } else {
    return { ok: false, message: `unsupported platform '${process.platform}'` };
  }
  return r.status === 0 ? { ok: true, message: "restarted" } : { ok: false, message: "service manager refused to start it" };
}

/** Short human-readable service state for `status`. */
export function serviceState() {
  if (!serviceInstalled()) return "not installed";
  if (process.platform === "linux") {
    const r = spawnSync("systemctl", ["--user", "is-active", `${LABEL}.service`], { encoding: "utf-8" });
    return `installed (${(r.stdout || "").trim() || "unknown"})`;
  }
  if (process.platform === "darwin") {
    const r = quiet("launchctl", ["print", launchdTarget()]);
    return r.status === 0 ? "installed (loaded)" : "installed (stopped)";
  }
  return "installed";
}

/**
 * Stop and unregister the service and delete its unit/plist/launcher.
 * Returns { removed, message }; removed=false when nothing was installed.
 */
export function removeService() {
  if (process.platform === "linux") {
    if (quiet("systemctl", ["--version"]).status === 0) {
      quiet("systemctl", ["--user", "disable", "--now", `${LABEL}.service`]);
      quiet("systemctl", ["--user", "daemon-reload"]);
    }
    return removeFile(unitPath(), "systemd unit");
  }
  if (process.platform === "darwin") {
    if (fs.existsSync(plistPath())) quiet("launchctl", ["unload", plistPath()]);
    return removeFile(plistPath(), "launchd service");
  }
  if (process.platform === "win32") {
    // Stop a running bridge first: /Delete leaves the process alive.
    quiet("schtasks", ["/End", "/TN", WIN_TASK]);
    const ok = loud("schtasks", ["/Delete", "/F", "/TN", WIN_TASK]).status === 0;
    fs.rmSync(winLauncherPath(), { force: true });
    return ok
      ? { removed: true, message: `Removed Scheduled Task '${WIN_TASK}'` }
      : { removed: false, message: `No Scheduled Task '${WIN_TASK}' (or removal failed)` };
  }
  return { removed: false, message: `Unsupported platform '${process.platform}'` };
}

function removeFile(file, what) {
  if (!fs.existsSync(file)) return { removed: false, message: `No ${what} found` };
  fs.rmSync(file, { force: true });
  return { removed: true, message: `Removed ${what}: ${file}` };
}
