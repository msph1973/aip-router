import { FIND_PER_DIR_MAX, FIND_TOTAL_DIR_MAX } from "../constants.js";

export function find(input) {
  const byDir = new Map();
  for (const line of input.split("\n")) {
    const t = line.trim();
    if (!t) continue;
    const idx = t.lastIndexOf("/");
    if (idx === -1) { if (!byDir.has(".")) byDir.set(".", []); byDir.get(".").push(t); continue; }
    const dir = t.slice(0, idx) || "/";
    const base = t.slice(idx + 1);
    if (!byDir.has(dir)) byDir.set(dir, []);
    byDir.get(dir).push(base);
  }
  if (byDir.size === 0) return input;
  const dirs = Array.from(byDir.entries()).slice(0, FIND_TOTAL_DIR_MAX);
  let totalFiles = 0;
  for (const [, files] of dirs) totalFiles += files.length;
  let out = `${totalFiles} files in ${byDir.size} dirs:\n`;
  for (const [dir, files] of dirs) {
    const show = files.slice(0, FIND_PER_DIR_MAX);
    out += `  ${dir}/ (${files.length}): ${show.join(", ")}`;
    if (files.length > FIND_PER_DIR_MAX) out += ` +${files.length - FIND_PER_DIR_MAX}`;
    out += "\n";
  }
  if (dirs.length < byDir.size) out += `  ... +${byDir.size - dirs.length} more dirs\n`;
  return out;
}
find.filterName = "find";
