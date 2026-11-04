// service.js — shared helpers for the per-OS background service
// (systemd user unit on Linux, launchd agent on macOS, Scheduled Task on Windows).
// Used by bin/cli.mjs (stop/restart/status) and install.mjs (--relogin).

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export const LABEL = "com.hermes.zaloplugin";
export const WIN_TASK = "HermesZaloPlugin";

export const unitPath = () =>
  path.join(os.homedir(), ".config", "systemd", "user", `${LABEL}.service`);
export const plistPath = () =>
  path.join(os.homedir(), "Library", "LaunchAgents", `${LABEL}.plist`);

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
