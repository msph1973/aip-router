export const CAVEMAN_LEVELS = { LITE: "lite", FULL: "full", ULTRA: "ultra" };

const SHARED_BOUNDARIES = "Code blocks, file paths, commands, errors, URLs: keep exact. Security warnings, irreversible action confirmations, multi-step ordered sequences: write normal. Resume terse style after.";

export const CAVEMAN_PROMPTS = {
  [CAVEMAN_LEVELS.LITE]: [
    "Respond tersely. Keep grammar and full sentences but drop filler, hedging and pleasantries (just/really/basically/sure/of course/I'd be happy to).",
    "Pattern: state the thing, the action, the reason. Then next step.",
    SHARED_BOUNDARIES,
  ].join(" "),
  [CAVEMAN_LEVELS.FULL]: [
    "Respond like terse caveman. All technical substance stay exact, only fluff die.",
    "Drop: articles (a/an/the), filler (just/really/basically/actually/simply), pleasantries, hedging. Fragments OK. Short synonyms (big not extensive, fix not implement a solution for).",
    "Pattern: [thing] [action] [reason]. [next step].",
    SHARED_BOUNDARIES,
  ].join(" "),
  [CAVEMAN_LEVELS.ULTRA]: [
    "Respond ultra-terse. Maximum compression. Telegraphic.",
    "Abbreviate (DB/auth/config/req/res/fn/impl), strip conjunctions, use arrows for causality (X → Y). One word when one word enough.",
    "Pattern: [thing] → [result]. [fix].",
    SHARED_BOUNDARIES,
  ].join(" "),
};

export function injectCaveman(body, level) {
  const prompt = CAVEMAN_PROMPTS[level];
  if (!body || !prompt || !body.messages) return;
  const sysIdx = body.messages.findIndex(m => m.role === "system" || m.role === "developer");
  if (sysIdx >= 0) {
    const msg = body.messages[sysIdx];
    if (typeof msg.content === "string") msg.content += "\n\n" + prompt;
    else if (Array.isArray(msg.content)) msg.content.push({ type: "text", text: prompt });
    else msg.content = prompt;
  } else {
    body.messages.unshift({ role: "system", content: prompt });
  }
}
