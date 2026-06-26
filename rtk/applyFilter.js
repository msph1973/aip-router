export function safeApply(fn, text) {
  try {
    return fn(text);
  } catch (e) {
    console.warn(`[RTK] filter ${fn.filterName || fn.name} error:`, e.message);
    return null;
  }
}
