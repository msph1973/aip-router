export function estimateContextUsage(body) {
  if (!body || !body.messages) return { chars: 0, estimatedTokens: 0, pct200k: 0, pct100k: 0 };
  let total = 0;
  for (const msg of body.messages) {
    if (typeof msg.content === "string") total += msg.content.length;
    else if (Array.isArray(msg.content)) {
      for (const block of msg.content) {
        if (typeof block === "string") total += block.length;
        else if (block?.text) total += block.text.length;
        else if (block?.content) total += block.content.length;
      }
    }
  }
  total += JSON.stringify(body).length;
  const estimatedTokens = Math.ceil(total / 3.5);
  const pct200k = (estimatedTokens / 200000) * 100;
  const pct100k = (estimatedTokens / 100000) * 100;
  return { chars: total, estimatedTokens, pct200k, pct100k };
}

export function formatHeadroomWarning(stats, threshold) {
  const warnings = [];
  if (stats.pct200k >= threshold)
    warnings.push(`⚠ Context: ~${stats.estimatedTokens.toLocaleString()} tokens (${stats.pct200k.toFixed(0)}% of 200K window)`);
  if (stats.pct100k >= threshold)
    warnings.push(`⚠ Heavy context: ${stats.pct100k.toFixed(0)}% of 100K window`);
  if (warnings.length > 0) return warnings.join("\n");
  return null;
}

export function addHeadroomWarning(body, threshold) {
  const stats = estimateContextUsage(body);
  const warning = formatHeadroomWarning(stats, threshold);
  if (!warning) return;
  if (!body.messages) body.messages = [];
  const lastMsg = body.messages[body.messages.length - 1];
  if (lastMsg) {
    if (typeof lastMsg.content === "string")
      lastMsg.content += "\n\n" + warning;
    else if (Array.isArray(lastMsg.content))
      lastMsg.content.push({ type: "text", text: warning });
  }
  return warning;
}
