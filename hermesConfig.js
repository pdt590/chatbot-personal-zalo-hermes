// hermesConfig.js
// Line-based edits of a Hermes config.yaml (no YAML dependency), used by the
// installer to turn on the toolsets this plugin provides.

/** Toolset names listed under `provides_toolsets:` in plugin.yaml. */
export function readProvidedToolsets(pluginYaml) {
  const lines = String(pluginYaml || "").split("\n");
  const start = lines.findIndex((l) => /^provides_toolsets:\s*$/.test(l));
  if (start === -1) return [];
  const out = [];
  for (const line of lines.slice(start + 1)) {
    const m = line.match(/^\s+-\s*["']?([\w.-]+)["']?\s*(#.*)?$/);
    if (m) out.push(m[1]);
    else if (line.trim() && !line.trim().startsWith("#")) break;
  }
  return out;
}

const indentOf = (line) => line.match(/^\s*/)[0].length;

/**
 * Make sure `platform_toolsets.<platform>` lists every name in `toolsets`.
 *
 * Plugin toolsets are on by default while the platform has no saved list, so
 * a missing `platform_toolsets` or `<platform>` entry is left alone (creating
 * one would switch off the platform's default toolsets).
 *
 * @returns {{ text: string, status: "default"|"already"|"added", added: string[] }}
 */
export function enablePlatformToolsets(cfgText, platform, toolsets) {
  const text = String(cfgText || "");
  const lines = text.split("\n");
  const top = lines.findIndex((l) => /^platform_toolsets:\s*$/.test(l));
  if (top === -1 || !toolsets.length) return { text, status: "default", added: [] };

  // The platform key: the first child of platform_toolsets named <platform>.
  let keyIdx = -1;
  for (let i = top + 1; i < lines.length; i++) {
    const l = lines[i];
    if (!l.trim() || l.trim().startsWith("#")) continue;
    if (indentOf(l) === 0) break; // left the block
    if (new RegExp(`^\\s+["']?${platform}["']?:`).test(l)) {
      keyIdx = i;
      break;
    }
  }
  if (keyIdx === -1) return { text, status: "default", added: [] };

  const keyLine = lines[keyIdx];
  const keyIndent = indentOf(keyLine);

  // Inline list: `zalo: [file, vision]`.
  const inline = keyLine.match(/^(\s*["']?[\w-]+["']?:\s*)\[(.*)\](\s*(#.*)?)$/);
  if (inline) {
    const items = inline[2].split(",").map((s) => s.trim().replace(/^["']|["']$/g, "")).filter(Boolean);
    const added = toolsets.filter((t) => !items.includes(t));
    if (!added.length) return { text, status: "already", added };
    lines[keyIdx] = `${inline[1]}[${[...items, ...added].join(", ")}]${inline[3] || ""}`;
    return { text: lines.join("\n"), status: "added", added };
  }
  // Anything else on the key line (a scalar or a quoted list string) is not
  // something we can extend safely.
  if (!/:\s*(#.*)?$/.test(keyLine)) {
    throw new Error(`platform_toolsets.${platform} is not a list; add ${toolsets.join(", ")} by hand`);
  }

  // Block list below the key.
  const items = [];
  let lastItem = keyIdx;
  let itemIndent = keyIndent + 2;
  for (let j = keyIdx + 1; j < lines.length; j++) {
    const l = lines[j];
    if (!l.trim() || l.trim().startsWith("#")) continue;
    const m = l.match(/^(\s*)-\s*["']?([^"'#\s]+)["']?/);
    if (m && m[1].length >= keyIndent) {
      items.push(m[2]);
      itemIndent = m[1].length;
      lastItem = j;
      continue;
    }
    break;
  }
  const added = toolsets.filter((t) => !items.includes(t));
  if (!added.length) return { text, status: "already", added };
  lines.splice(lastItem + 1, 0, ...added.map((t) => `${" ".repeat(itemIndent)}- ${t}`));
  return { text: lines.join("\n"), status: "added", added };
}

// ── hooks.pre_tool_call: register / unregister the Zalo tool-access hook ─────

export const HOOK_FILE = "zalo-tool-access.py";

const isBlank = (l) => !l.trim() || l.trim().startsWith("#");

/** Index just past the last line of the block whose key sits at `keyIdx`. */
function blockEnd(lines, keyIdx) {
  const keyIndent = indentOf(lines[keyIdx]);
  let end = keyIdx + 1;
  for (let j = keyIdx + 1; j < lines.length; j++) {
    if (isBlank(lines[j])) continue;
    const ind = indentOf(lines[j]);
    // A sequence may sit at the key's own indent ("key:\n- a").
    if (ind > keyIndent || (ind === keyIndent && /^\s*-(\s|$)/.test(lines[j]))) {
      end = j + 1;
      continue;
    }
    break;
  }
  return end;
}

// `key:` with no value, or an empty value ([] {} null ~), optionally commented.
const EMPTY_KEY_RE = /^\s*[A-Za-z0-9_.-]+:\s*(\[\s*\]|\{\s*\}|null|~)?\s*(#.*)?$/;

/**
 * Delete the key at `keyIdx` when nothing is left under it, then its parent if
 * that is now empty too, and so on up to the top level. A removed top-level key
 * also takes the blank lines that separated it from the previous block, when
 * nothing (or another blank line) follows. Mutates `lines`.
 */
function pruneEmptyKeys(lines, keyIdx) {
  while (keyIdx >= 0 && keyIdx < lines.length) {
    if (!EMPTY_KEY_RE.test(lines[keyIdx]) || blockEnd(lines, keyIdx) !== keyIdx + 1) return;
    const indent = indentOf(lines[keyIdx]);
    let parent = -1;
    if (indent > 0) {
      for (let i = keyIdx - 1; i >= 0; i--) {
        if (!isBlank(lines[i]) && indentOf(lines[i]) < indent) { parent = i; break; }
      }
    }
    lines.splice(keyIdx, 1);
    if (indent === 0) {
      let b = keyIdx;
      while (b > 0 && !lines[b - 1].trim()) b--;
      const restBlank = lines.slice(keyIdx).every((l) => !l.trim());
      if (b < keyIdx && (restBlank || !lines[keyIdx].trim())) lines.splice(b, keyIdx - b);
      return;
    }
    keyIdx = parent;
  }
}

function hookEntry(command, indent) {
  const pad = " ".repeat(indent);
  return [
    `${pad}- command: ${JSON.stringify(command)}`,
    `${pad}  timeout: 10`,
    `${pad}  fail_closed: true`,
  ];
}

/**
 * Add a `hooks.pre_tool_call` entry running `command`, unless an entry for
 * zalo-tool-access.py is already there (then its command is refreshed).
 *
 * @returns {{ text: string, status: "already"|"updated"|"added" }}
 */
export function addPreToolHook(cfgText, command) {
  const text = String(cfgText || "");
  const lines = text.split("\n");

  // Existing entry: keep it, but point it at `command`.
  const existing = lines.findIndex((l) => /^\s*-?\s*command:/.test(l) && l.includes(HOOK_FILE));
  if (existing !== -1) {
    const m = lines[existing].match(/^(\s*-?\s*command:\s*)(.*?)\s*$/);
    const value = JSON.stringify(command);
    if (m[2] === value) return { text, status: "already" };
    lines[existing] = m[1] + value;
    return { text: lines.join("\n"), status: "updated" };
  }

  let top = lines.findIndex((l) => /^hooks:/.test(l));
  if (top === -1) {
    const sep = text.length && !text.endsWith("\n") ? "\n" : "";
    const block = ["hooks:", "  pre_tool_call:", ...hookEntry(command, 4)].join("\n");
    return { text: `${text}${sep}${block}\n`, status: "added" };
  }
  if (/^hooks:\s*(\{\s*\}|null|~)?\s*(#.*)?$/.test(lines[top])) {
    lines[top] = "hooks:";
  } else {
    throw new Error("hooks: is not a mapping; add the pre_tool_call entry by hand");
  }

  const end = blockEnd(lines, top);
  let keyIdx = -1;
  let childIndent = 2;
  for (let i = top + 1; i < end; i++) {
    if (isBlank(lines[i])) continue;
    if (childIndent === 2 && indentOf(lines[i]) > 0) childIndent = indentOf(lines[i]);
    if (/^\s+pre_tool_call:/.test(lines[i]) && indentOf(lines[i]) === childIndent) {
      keyIdx = i;
      break;
    }
  }
  if (keyIdx === -1) {
    lines.splice(top + 1, 0, `${" ".repeat(childIndent)}pre_tool_call:`, ...hookEntry(command, childIndent + 2));
    return { text: lines.join("\n"), status: "added" };
  }
  if (/:\s*(\[\s*\]|null|~)\s*(#.*)?$/.test(lines[keyIdx])) {
    lines[keyIdx] = `${" ".repeat(childIndent)}pre_tool_call:`;
  } else if (!/:\s*(#.*)?$/.test(lines[keyIdx])) {
    throw new Error("hooks.pre_tool_call is not a list; add the entry by hand");
  }
  const listEnd = blockEnd(lines, keyIdx);
  let itemIndent = childIndent + 2;
  for (let j = keyIdx + 1; j < listEnd; j++) {
    const m = lines[j].match(/^(\s*)-(\s|$)/);
    if (m) { itemIndent = m[1].length; break; }
  }
  // Insert after the last non-blank line of the list.
  let at = listEnd;
  while (at > keyIdx + 1 && isBlank(lines[at - 1])) at--;
  lines.splice(at, 0, ...hookEntry(command, itemIndent));
  return { text: lines.join("\n"), status: "added" };
}

/**
 * Remove the `hooks.pre_tool_call` entry that runs zalo-tool-access.py.
 * An emptied `pre_tool_call` (and then an emptied `hooks:`) is removed; other
 * hooks are untouched.
 *
 * @returns {{ text: string, removed: boolean }}
 */
export function removePreToolHook(cfgText) {
  const text = String(cfgText || "");
  const lines = text.split("\n");
  const cmd = lines.findIndex((l) => /^\s*-?\s*command:/.test(l) && l.includes(HOOK_FILE));
  if (cmd === -1) return { text, removed: false };

  // The item starts at the "-" line at or above the command line.
  let start = cmd;
  while (start > 0 && !/^\s*-(\s|$)/.test(lines[start])) start--;
  const dashIndent = indentOf(lines[start]);
  let end = start + 1;
  for (let j = start + 1; j < lines.length; j++) {
    if (isBlank(lines[j])) continue;
    if (indentOf(lines[j]) > dashIndent) { end = j + 1; continue; }
    break;
  }
  lines.splice(start, end - start);

  // The pre_tool_call key above the removed item: drop it (and hooks:) if empty.
  let key = start - 1;
  while (key >= 0 && !/^\s*pre_tool_call:\s*(#.*)?$/.test(lines[key])) key--;
  pruneEmptyKeys(lines, key);
  return { text: lines.join("\n"), removed: true };
}

/** Set `KEY=value` in a dotenv text (replaces an existing, uncommented line). */
export function setEnvVar(envText, key, value) {
  const text = String(envText || "");
  const lines = text.split("\n");
  const idx = lines.findIndex((l) => new RegExp(`^\\s*(export\\s+)?${key}=`).test(l));
  const line = `${key}=${value}`;
  if (idx !== -1) {
    if (lines[idx].trim() === line) return { text, changed: false };
    lines[idx] = line;
    return { text: lines.join("\n"), changed: true };
  }
  const sep = text.length && !text.endsWith("\n") ? "\n" : "";
  return { text: `${text}${sep}${line}\n`, changed: true };
}

// ── plugins.enabled: enable / disable the Zalo adapter plugin ───────────────
// Line-based edits (no YAML dependency) of the one list we need.

export const PLUGIN_NAME = "zalo-platform";

/**
 * Ensure plugins.enabled contains "zalo-platform" (inline or block list).
 * Returns { text, status: "already" | "added" | "created" }.
 */
export function enablePluginInConfig(cfgText) {
  const text = cfgText || "";
  const lines = text.split("\n");

  // A top-level "plugins:" line (no leading whitespace).
  const pluginsIdx = lines.findIndex((l) => /^plugins:\s*$/.test(l));
  if (pluginsIdx === -1) {
    const sep = text.length && !text.endsWith("\n") ? "\n" : "";
    return { text: `${text}${sep}\nplugins:\n  enabled:\n    - ${PLUGIN_NAME}\n`, status: "created" };
  }

  const enabledIdx = findEnabled(lines, pluginsIdx);
  if (enabledIdx === -1) {
    // plugins: exists but no enabled: — insert one right after plugins:.
    lines.splice(pluginsIdx + 1, 0, "  enabled:", `    - ${PLUGIN_NAME}`);
    return { text: lines.join("\n"), status: "added" };
  }

  const inline = lines[enabledIdx].match(/enabled:\s*\[(.*)\]/);
  if (inline) {
    if (new RegExp(`(^|[,\\s])${PLUGIN_NAME}([,\\s]|$)`).test(inline[1])) return { text, status: "already" };
    const items = inline[1].trim();
    lines[enabledIdx] = lines[enabledIdx].replace(
      /enabled:\s*\[.*\]/,
      `enabled: [${items ? items + ", " : ""}${PLUGIN_NAME}]`,
    );
    return { text: lines.join("\n"), status: "added" };
  }

  // Block list: insert after the last real item (not after trailing blanks).
  let lastItem = enabledIdx;
  for (let j = enabledIdx + 1; j < lines.length; j++) {
    if (new RegExp(`^\\s*-\\s*['"]?${PLUGIN_NAME}['"]?\\s*$`).test(lines[j])) return { text, status: "already" };
    if (/^\s*-\s/.test(lines[j])) { lastItem = j; continue; }
    if (lines[j].trim() === "") continue;
    break;
  }
  lines.splice(lastItem + 1, 0, `    - ${PLUGIN_NAME}`);
  return { text: lines.join("\n"), status: "added" };
}

/**
 * Drop "zalo-platform" from plugins.enabled (inline or block list). An emptied
 * `enabled:` (and then an emptied `plugins:`) is removed too.
 * Returns { text, removed }.
 */
export function disablePluginInConfig(cfgText) {
  const text = cfgText || "";
  const lines = text.split("\n");
  const pluginsIdx = lines.findIndex((l) => /^plugins:\s*$/.test(l));
  if (pluginsIdx === -1) return { text, removed: false };
  const enabledIdx = findEnabled(lines, pluginsIdx);
  if (enabledIdx === -1) return { text, removed: false };

  const inline = lines[enabledIdx].match(/^(\s*enabled:\s*)\[(.*)\]\s*$/);
  if (inline) {
    const items = inline[2].split(",").map((s) => s.trim()).filter(Boolean);
    const kept = items.filter((s) => s.replace(/^['"]|['"]$/g, "") !== PLUGIN_NAME);
    if (kept.length === items.length) return { text, removed: false };
    lines[enabledIdx] = `${inline[1]}[${kept.join(", ")}]`;
    pruneEmptyKeys(lines, enabledIdx);
    return { text: lines.join("\n"), removed: true };
  }

  for (let j = enabledIdx + 1; j < lines.length; j++) {
    if (new RegExp(`^\\s*-\\s*['"]?${PLUGIN_NAME}['"]?\\s*$`).test(lines[j])) {
      lines.splice(j, 1);
      pruneEmptyKeys(lines, enabledIdx);
      return { text: lines.join("\n"), removed: true };
    }
    if (/^\s*-\s/.test(lines[j]) || lines[j].trim() === "") continue;
    break;
  }
  return { text, removed: false };
}

// Index of "enabled:" inside the top-level plugins: block, or -1.
function findEnabled(lines, pluginsIdx) {
  for (let i = pluginsIdx + 1; i < lines.length; i++) {
    if (/^\S/.test(lines[i]) && lines[i].trim() !== "") return -1; // left the block
    if (/^\s+enabled:/.test(lines[i])) return i;
  }
  return -1;
}
