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
  ingrazzioUrl: "https://ingrazzio-cloud-prod.labs.jb.gg",

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

  // Default max output tokens when the client doesn't set one. 8192 is the
  // previous Anthropic default — generous but wasteful for agents that don't
  // care how long the reply is. 2048 is a sane floor that still covers most
  // real answers while bounding runaway responses.
  defaultMaxTokens: parseInt(process.env.DEFAULT_MAX_TOKENS || "2048", 10),
};
