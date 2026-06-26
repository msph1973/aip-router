/** Safe JSON parse — returns fallback on failure instead of throwing. */
export function safeParseJson(str, fallback = null) {
  try { return JSON.parse(str); } catch { return fallback; }
}
