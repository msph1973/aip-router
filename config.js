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

// Numeric env knob with a safe fallback. Bare parseInt returns NaN for junk
// ("abc") and silently truncates units ("5MB" -> 5, "1e6" -> 1), and NaN then
// slips past ordinary comparison guards because every comparison with NaN is
// false. Anything that isn't a finite integer in range falls back to the
// default instead of poisoning downstream logic.
function envInt(raw, fallback, { min = 0, max = Number.MAX_SAFE_INTEGER } = {}) {
  if (raw === undefined || raw === null || String(raw).trim() === "") return fallback;
  const str = String(raw).trim();
  // Reject trailing junk that parseInt would happily ignore.
  if (!/^-?\d+$/.test(str)) return fallback;
  const n = Number.parseInt(str, 10);
  if (!Number.isFinite(n) || n < min || n > max) return fallback;
  return n;
}

export const CONFIG = {
  port: envInt(process.env.PORT, 20129, { min: 1, max: 65535 }),
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
  headroomThreshold: envInt(process.env.HEADROOM_THRESHOLD, 80),

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
  defaultMaxTokens: envInt(process.env.DEFAULT_MAX_TOKENS, 2048, { min: 1 }),

  // Models advertised by GET /v1/models (for omp/yaak/junie model discovery).
  // Only these three are supported/expected to work through the router.
  models: (process.env.AIP_MODELS || "deepseek-v4-flash,gemini-3.7-flash,claude-sonnet-5")
    .split(",").map(s => s.trim()).filter(Boolean),

  // JSONL log rotation (D2). router.jsonl grows unbounded while the server
  // runs; these bound it. AIP_LOG_MAX_BYTES is the size at which the current
  // file rolls, AIP_LOG_ROTATE is how many rotated backups are kept (oldest
  // dropped). Both are pure ops knobs — they never touch the request path.
  // 0 (or below) on either knob disables rotation entirely.
  logMaxBytes: envInt(process.env.AIP_LOG_MAX_BYTES, 5 * 1024 * 1024),
  // Capped: rotateJsonl walks this many slots on every write once the
  // threshold is crossed, so an absurd value would stall the log path
  // (1,000,000 measured at ~2.1s per write). 64 archives is far past any
  // real retention need.
  logRotate: envInt(process.env.AIP_LOG_ROTATE, 3, { max: 64 }),
};
