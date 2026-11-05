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
