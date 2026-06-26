import { DEDUP_LINE_MAX } from "../constants.js";

export function dedupLog(input) {
  const lines = input.split("\n");
  if (lines.length < 5) return input;
  const out = [];
  let prev = null;
  let dupCount = 0;
  let blankCount = 0;
  for (const line of lines) {
    if (line.trim() === "") {
      blankCount++;
      if (blankCount > 1) continue;
    } else blankCount = 0;
    if (line === prev) {
      dupCount++;
      continue;
    }
    if (dupCount > 1) out.push(`  ... (${dupCount} duplicate lines)`);
    dupCount = 1;
    out.push(line);
    prev = line;
  }
  if (dupCount > 1) out.push(`  ... (${dupCount} duplicate lines)`);
  if (out.length > DEDUP_LINE_MAX) {
    const head = out.slice(0, 100);
    const tail = out.slice(out.length - 50);
    return [...head, `... +${out.length - 150} lines truncated`, ...tail].join("\n");
  }
  return out.join("\n");
}
dedupLog.filterName = "dedup-log";
