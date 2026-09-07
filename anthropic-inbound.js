// Prompt-cache breakpoint graft for POST /v1/messages (pure — no side effects).
//
// The client's cache_control markers are collected into a sidecar during
// Anthropic->OpenAI translation (server.js translateAnthropicToOpenAI):
//   body._sysCache            — cache_control object from system blocks
//   tool._cache               — cache_control object from a tool definition
//   message._cache            — [{ anchor, cacheControl }] where anchor is
//     { kind:"text" } | { kind:"tool_use", id } | { kind:"tool_result", tool_use_id }
// graftAnthropicCache copies them back onto the upstream Anthropic body.
// Matching is anchor-based, immune to saver mutations: RTK/headroom edit in
// place, caveman/ponytail only unshift a system message (skipped by the zip).
//
// Sidecar keys are underscore-prefixed and must be stripped via
// stripInternalMeta before any body is sent upstream verbatim (the deepseek /
// openai family proxies chatBody directly; the anthropic/gemini families
// build fresh bodies and never leak them, but stripping is still applied).

export const MAX_CACHE_BREAKPOINTS = 4;

// Graft the client's cache breakpoints (sidecar on chatBody) back onto the
// upstream Anthropic body. Returns { applied, dropped }; when over budget the
// earliest breakpoints are dropped (a later breakpoint's cached prefix is a
// superset of an earlier one's).
export function graftAnthropicCache(anUpBody, chatBody) {
  const ops = [];

  if (chatBody._sysCache && typeof anUpBody.system === "string" && anUpBody.system) {
    const cc = chatBody._sysCache;
    ops.push(() => {
      anUpBody.system = [{ type: "text", text: anUpBody.system, cache_control: cc }];
    });
  }

  const upTools = Array.isArray(anUpBody.tools) ? anUpBody.tools : [];
  for (const t of chatBody.tools || []) {
    if (t && t._cache && t.function && t.function.name) {
      const target = upTools.find(u => u && u.name === t.function.name);
      if (target) {
        const cc = t._cache;
        ops.push(() => { target.cache_control = cc; });
      }
    }
  }

  const upMsgs = Array.isArray(anUpBody.messages) ? anUpBody.messages : [];
  let ui = 0;
  for (const m of chatBody.messages || []) {
    if (!m || m.role === "system") continue; // folded into system / unshifted prompt
    const up = upMsgs[ui++];
    if (!up) break;
    for (const rec of m._cache || []) {
      const cc = rec && rec.cacheControl;
      const anchor = (rec && rec.anchor) || { kind: "text" };
      if (!cc) continue;
      ops.push(() => {
        if (!up.content) {
          up.content = [{ type: "text", text: "", cache_control: cc }];
          return;
        }
        if (anchor.kind === "tool_use" && Array.isArray(up.content)) {
          const blk = up.content.find(b => b && b.type === "tool_use" && (!anchor.id || b.id === anchor.id));
          if (blk) { blk.cache_control = cc; return; }
        } else if (anchor.kind === "tool_result" && Array.isArray(up.content)) {
          const blk = up.content.find(b => b && b.type === "tool_result" && (!anchor.tool_use_id || b.tool_use_id === anchor.tool_use_id));
          if (blk) { blk.cache_control = cc; return; }
        }
        // Text anchor, or id lookup missed: attach to the last text block,
        // else the last block, else synthesize one.
        if (typeof up.content === "string") {
          up.content = [{ type: "text", text: up.content, cache_control: cc }];
        } else if (Array.isArray(up.content) && up.content.length) {
          let target = null;
          for (let i = up.content.length - 1; i >= 0; i--) {
            if (up.content[i] && up.content[i].type === "text") { target = up.content[i]; break; }
          }
          (target || up.content[up.content.length - 1]).cache_control = cc;
        } else {
          up.content = [{ type: "text", text: "", cache_control: cc }];
        }
      });
    }
  }

  const keep = ops.slice(-MAX_CACHE_BREAKPOINTS);
  for (const apply of keep) apply();
  return { applied: keep.length, dropped: ops.length - keep.length };
}

// Remove the breakpoint sidecar so it never leaks upstream or to clients.
export function stripInternalMeta(chatBody) {
  if (!chatBody || typeof chatBody !== "object") return;
  delete chatBody._sysCache;
  if (Array.isArray(chatBody.messages)) {
    for (const m of chatBody.messages) {
      if (m && typeof m === "object") delete m._cache;
    }
  }
  if (Array.isArray(chatBody.tools)) {
    for (const t of chatBody.tools) {
      if (t && typeof t === "object") delete t._cache;
    }
  }
}
