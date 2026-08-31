// Parse multiple tokens from env: comma-separated, each as "name:token" or just "token"
// AIP_TOKEN=name1:perm-xxx,name2:perm-yyy
// or env vars: AIP_TOKEN (single, legacy), JUNP_TOKEN, etc.
function parseTokens(str) {
  if (!str) return [];
  return str.split(",").map((entry, i) => {
    entry = entry.trim();
    const colon = entry.indexOf(":");
    if (colon > 0) {
      return { name: entry.slice(0, colon), token: entry.slice(colon + 1) };
    }
    return { name: `token${i}`, token: entry };
  });
}

function getTokens() {
  const multi = process.env.AIP_TOKENS || "";
  const legacy = process.env.AIP_TOKEN || "";
  if (multi) return parseTokens(multi);
  if (legacy) return [{ name: "aip", token: legacy }];
  return [];
}

export const CONFIG = {
  port: parseInt(process.env.PORT || "20129", 10),
  ingrazzioUrl: process.env.INGRAZZIO_URL || "https://ingrazzio-cloud-prod.labs.jb.gg",

  tokens: getTokens(),

  // Junie identity headers — capture from a real Junie CLI run, not hardcoded,
  // so they can be bumped without code edits when JetBrains ships a new version.
  junieUserAgent: process.env.JUNIE_UA || "junie-cli:26.8.31-eap",
  junieVersion: process.env.JUNIE_VERSION || "3013.2",

  rtkEnabled: process.env.RTK_ENABLED !== "false",
  rtkTruncate: process.env.RTK_TRUNCATE !== "false",
  cavemanEnabled: process.env.CAVEMAN_ENABLED === "true",
  cavemanLevel: process.env.CAVEMAN_LEVEL || "full",
  ponytailEnabled: process.env.PONYTAIL_ENABLED === "true",
  headroomEnabled: process.env.HEADROOM_ENABLED === "true",
  headroomThreshold: parseInt(process.env.HEADROOM_THRESHOLD || "80", 10),

  // Reasoning budget knob (A3). "off" (default) keeps deepseek's
  // reasoning_content untouched — the earlier decision was NOT to strip
  // reasoning by default (it is 19–99% of completion tokens and removing it
  // can lower answer quality). Set AIP_BUDGET=strip (or per-request header
  // X-AIP-Budget: strip) to opt into stripping reasoning_content from
  // non-stream deepseek responses and save quota deliberately.
  reasoningBudget: process.env.AIP_BUDGET || "off",

  // Default max output tokens when the client doesn't set one. 8192 is the
  // previous Anthropic default — generous but wasteful for agents that don't
  // care how long the reply is. 2048 is a sane floor that still covers most
  // real answers while bounding runaway responses.
  defaultMaxTokens: parseInt(process.env.DEFAULT_MAX_TOKENS || "2048", 10),

  // Models advertised by GET /v1/models (for omp/yaak/junie model discovery).
  // Only these three are supported/expected to work through the router.
  models: (process.env.AIP_MODELS || "deepseek-v4-flash,gemini-3.7-flash,claude-sonnet-5")
    .split(",").map(s => s.trim()).filter(Boolean),

  // JSONL log rotation (D2). router.jsonl grows unbounded while the server
  // runs; these bound it. AIP_LOG_MAX_BYTES is the size at which the current
  // file rolls, AIP_LOG_ROTATE is how many rotated backups are kept (oldest
  // dropped). Both are pure ops knobs — they never touch the request path.
  logMaxBytes: parseInt(process.env.AIP_LOG_MAX_BYTES || (5 * 1024 * 1024), 10),
  logRotate: parseInt(process.env.AIP_LOG_ROTATE || "3", 10),
};
