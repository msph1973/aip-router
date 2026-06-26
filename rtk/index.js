import { RAW_CAP, MIN_COMPRESS_SIZE } from "./constants.js";
import { autoDetectFilter } from "./autodetect.js";
import { safeApply } from "./applyFilter.js";

export function compressMessages(body) {
  if (!body) return null;
  const items = Array.isArray(body.messages) ? body.messages : null;
  if (!items) return null;

  const stats = { bytesBefore: 0, bytesAfter: 0, hits: [] };
  for (let i = 0; i < items.length; i++) {
    const msg = items[i];
    if (!msg) continue;
    if (msg.role === "tool" && typeof msg.content === "string") {
      msg.content = compressText(msg.content, stats, "tool-result");
      continue;
    }
    if (!Array.isArray(msg.content)) continue;
    for (let j = 0; j < msg.content.length; j++) {
      const block = msg.content[j];
      if (!block || block.type !== "tool_result") continue;
      if (block.is_error) continue;
      if (typeof block.content === "string")
        block.content = compressText(block.content, stats, "tool-result");
      else if (Array.isArray(block.content)) {
        for (let k = 0; k < block.content.length; k++) {
          const part = block.content[k];
          if (part && part.type === "text" && typeof part.text === "string")
            part.text = compressText(part.text, stats, "tool-result");
        }
      }
    }
  }
  return stats;
}

function compressText(text, stats, shape) {
  const bytesIn = text.length;
  stats.bytesBefore += bytesIn;
  if (bytesIn < MIN_COMPRESS_SIZE || bytesIn > RAW_CAP) {
    stats.bytesAfter += bytesIn;
    return text;
  }
  const fn = autoDetectFilter(text);
  if (!fn) { stats.bytesAfter += bytesIn; return text; }
  const out = safeApply(fn, text);
  if (!out || out.length === 0 || out.length >= bytesIn) {
    stats.bytesAfter += bytesIn;
    return text;
  }
  stats.bytesAfter += out.length;
  stats.hits.push({ shape, filter: fn.filterName || fn.name, saved: bytesIn - out.length });
  return out;
}

export function formatRtkLog(stats) {
  if (!stats || !stats.hits || stats.hits.length === 0) return null;
  const saved = stats.bytesBefore - stats.bytesAfter;
  const pct = stats.bytesBefore > 0 ? ((saved / stats.bytesBefore) * 100).toFixed(1) : "0";
  const filters = Array.from(new Set(stats.hits.map(h => h.filter))).join(",");
  return `[RTK] saved ${saved}B / ${stats.bytesBefore}B (${pct}%) via [${filters}] hits=${stats.hits.length}`;
}
