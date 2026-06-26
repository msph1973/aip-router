import { LS_EXT_SUMMARY_TOP, LS_NOISE_DIRS } from "../constants.js";

export function ls(input) {
  const lines = input.split("\n");
  const entries = [];
  for (const line of lines) {
    const t = line.trim();
    if (!t || t.startsWith("total ")) continue;
    if (t.startsWith("d") || t.startsWith("-") || t.startsWith("l")) {
      const parts = t.split(/\s+/);
      const name = parts[parts.length - 1];
      const size = parts.length > 4 ? parts[4] : "?";
      if (!LS_NOISE_DIRS.includes(name) && !name.startsWith("."))
        entries.push({ name, size, isDir: t.startsWith("d") });
    }
  }
  const exts = {};
  let totalSize = 0;
  for (const e of entries) {
    totalSize += parseInt(e.size) || 0;
    const dot = e.name.lastIndexOf(".");
    if (dot > 0) { const ext = e.name.slice(dot); exts[ext] = (exts[ext] || 0) + 1; }
  }
  const extSorted = Object.entries(exts).sort((a, b) => b[1] - a[1]).slice(0, LS_EXT_SUMMARY_TOP);
  let out = `${entries.length} entries, total ${totalSize}B\n`;
  if (extSorted.length > 0) out += `ext: ${extSorted.map(([e, n]) => `${e}×${n}`).join(", ")}\n`;
  const dirs = entries.filter(e => e.isDir).map(e => e.name);
  const files = entries.filter(e => !e.isDir).map(e => `${e.name}\t${e.size}B`);
  if (dirs.length > 0) out += `dirs: ${dirs.join(", ")}\n`;
  if (files.length > 0) out += `files:\n  ${files.join("\n  ")}\n`;
  return out;
}
ls.filterName = "ls";
