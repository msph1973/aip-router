import { RAW_CAP, MIN_COMPRESS_SIZE } from "./constants.js";
import { autoDetectFilter } from "./autodetect.js";
import { safeApply } from "./applyFilter.js";
import { smartTruncate } from "./filters/smartTruncate.js";

export function compressMessages(body, opts = {}) {
  if (!body) return null;
  const items = Array.isArray(body.messages) ? body.messages : null;
  if (!items) return null;

  // rtkTruncate is enabled by default; the smartTruncate fallback is a safety
  // net for long run-on text (unique JSON dumps, monospace output) that no
  // pattern filter matches. Default-on because the cooldown over a run-on body
  // is the token-waste this feature exists to stop.
  const truncate = opts.truncate !== false;

  const stats = { bytesBefore: 0, bytesAfter: 0, hits: [] };
  for (let i = 0; i < items.length; i++) {
    const msg = items[i];
    if (!msg) continue;
    if (msg.role === "tool" && typeof msg.content === "string") {
      msg.content = compressText(msg.content, stats, "tool-result", truncate);
      continue;
    }
    if (!Array.isArray(msg.content)) continue;
    for (let j = 0; j < msg.content.length; j++) {
      const block = msg.content[j];
      if (!block || block.type !== "tool_result") continue;
      if (block.is_error) continue;
      if (typeof block.content === "string")
        block.content = compressText(block.content, stats, "tool-result", truncate);
      else if (Array.isArray(block.content)) {
        for (let k = 0; k < block.content.length; k++) {
          const part = block.content[k];
          if (part && part.type === "text" && typeof part.text === "string")
            part.text = compressText(part.text, stats, "tool-result", truncate);
        }
      }
    }
  }
  return stats;
}

function compressText(text, stats, shape, truncate) {
  const bytesIn = text.length;
  stats.bytesBefore += bytesIn;
  if (bytesIn < MIN_COMPRESS_SIZE || bytesIn > RAW_CAP) {
    stats.bytesAfter += bytesIn;
    return text;
  }
  const fn = autoDetectFilter(text);
  if (fn) {
    const out = safeApply(fn, text);
    if (out && out.length > 0 && out.length < bytesIn) {
      stats.bytesAfter += out.length;
      stats.hits.push({ shape, filter: fn.filterName || fn.name, saved: bytesIn - out.length });
      return out;
    }
  }
  // Pattern filter matched but didn't save (e.g. dedupLog on all-unique lines),
  // or no filter matched. Fall back to smartTruncate when enabled — it keeps
  // head+tail and drops the middle, avoiding token waste on run-on output.
  if (truncate) {
    const stOut = safeApply(smartTruncate, text);
    if (stOut && stOut.length > 0 && stOut.length < bytesIn) {
      stats.bytesAfter += stOut.length;
      stats.hits.push({ shape, filter: smartTruncate.filterName, saved: bytesIn - stOut.length });
      return stOut;
    }
  }
  stats.bytesAfter += bytesIn;
  return text;
}

export function formatRtkLog(stats) {
  if (!stats || !stats.hits || stats.hits.length === 0) return null;
  const saved = stats.bytesBefore - stats.bytesAfter;
  const pct = stats.bytesBefore > 0 ? ((saved / stats.bytesBefore) * 100).toFixed(1) : "0";
  const filters = Array.from(new Set(stats.hits.map(h => h.filter))).join(",");
  return `[RTK] saved ${saved}B / ${stats.bytesBefore}B (${pct}%) via [${filters}] hits=${stats.hits.length}`;
}
