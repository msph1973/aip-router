// Parse multiple tokens from env: comma-separated, each as "name:token" or just "token"
// AIP_TOKEN=name1:perm-xxx,name2:perm-yyy
// or env vars: AIP_TOKEN (single, legacy), JUNP_TOKEN, etc.
function parseTokens(str) {
  if (!str) return [];
  return str.split(",").map((entry, i) => {
    entry = entry.trim();
    const colon = entry.indexOf(":");
    if (colon > 0 && colon < 20) {
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

  rtkEnabled: process.env.RTK_ENABLED !== "false",
  cavemanEnabled: process.env.CAVEMAN_ENABLED === "true",
  cavemanLevel: process.env.CAVEMAN_LEVEL || "full",
  ponytailEnabled: process.env.PONYTAIL_ENABLED === "true",
  headroomEnabled: process.env.HEADROOM_ENABLED === "true",
  headroomThreshold: parseInt(process.env.HEADROOM_THRESHOLD || "80", 10),
};
