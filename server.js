import express from "express";
import crypto from "crypto";
import { CONFIG } from "./config.js";
import { compressMessages, formatRtkLog } from "./rtk/index.js";
import { injectCaveman } from "./prompts/caveman.js";
import { injectPonytail } from "./prompts/ponytail.js";
import { addHeadroomWarning } from "./headroom.js";
import { proxyToIngrazzio, translateOpenAIToAnthropic, translateOpenAIToGoogle, translateGoogleResponseToOpenAI, getBreakerState } from "./ingrazzio.js";
import { safeParseJson } from "./util.js";

const app = express();

app.use(express.json({ limit: "50mb" }));
app.use(express.text({ limit: "50mb", type: "text/plain" }));

// CORS — required by most AI frontends (Open WebUI, LibreChat, Chatbox, etc.)
app.use((req, res, next) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "*");
  if (req.method === "OPTIONS") return res.status(204).end();
  next();
});

// ---- Structured logging: readable stdout (for TUI) + full JSONL file (catch-all) ----
import { appendFileSync, mkdirSync } from "fs";
import { join } from "path";
import { homedir } from "os";

const LOG_DIR = join(homedir(), ".aip-router");
const LOG_FILE = join(LOG_DIR, "router.jsonl");

function writeJsonl(entry) {
  try {
    mkdirSync(LOG_DIR, { recursive: true });
    appendFileSync(LOG_FILE, JSON.stringify(entry) + "\n");
  } catch (_) { /* logging must never crash the router */ }
}

// Human-readable, structured, catch-all logger.
//  - Prints one line to stdout (kept compact: the TUI streams this line-for-line).
//  - Appends a *complete* JSON object to router.jsonl (truncation-free audit trail).
function log(level, ...args) {
  const ts = new Date().toISOString();
  const msg = args.map(a => typeof a === "string" ? a : safeStringify(a)).join(" ");
  // stdout line — same shape as before ([req]/[RTK]/[token]/[done] tokens preserved
  // so the TUI's log styling keeps working).
  console.log(`[${ts}] [${level}]`, msg);
  // JSONL file — always full fidelity.
  writeJsonl({ ts, level, type: level, message: msg });
}

// Serialize any value without throwing (JSONL is catch-all, may receive Errors etc.)
function safeStringify(v) {
  try { return JSON.stringify(v); } catch { return String(v); }
}

// Per-request timeline recorder. Stores start time + metadata, emits structured
// log entries at arrival and completion so every request is fully traceable.
const REQ_CAP = 200;
const activeReqs = new Map();

function requestStarted(req, body) {
  const toolNames = (body.tools || []).map(t => t.function?.name || t.name || "?").filter(Boolean);
  const msgSummary = (body.messages || []).map(m =>
    `${m.role}:${typeof m.content === "string" ? m.content.length : Array.isArray(m.content) ? `parts[${m.content.length}]` : "?"}`);
  const approxTokens = Math.ceil(JSON.stringify(body).length / 3.5);
  const rec = {
    id: req.reqId,
    start: Date.now(),
    model: body.model,
    stream: !!body.stream,
    tools: toolNames,
    msgSummary,
    approxTokens,
    family: null,
    llmModel: null,
    token: null,
  };
  if (activeReqs.size >= REQ_CAP) activeReqs.delete(activeReqs.keys().next().value);
  activeReqs.set(req.reqId, rec);
  log("req",
    `[${req.reqId}] model=${body.model} stream=${rec.stream} tools=[${toolNames.join(",")}] msgs=[${msgSummary.join("|")}] ~${approxTokens}tok`);
  return rec;
}

function requestCompleted(req, outcome) {
  const rec = activeReqs.get(req.reqId);
  if (!rec) return;
  const dur = Date.now() - rec.start;
  activeReqs.delete(req.reqId);
  const done = { ...rec, durMs: dur, ...outcome };
  // stdout — compact single line (TUI styles [done] in white).
  log("done",
    `[${req.reqId}] ${outcome.status || "?"} ${outcome.family || rec.family || "?"} ${rec.model} ${dur}ms tok=${rec.token || "?"}${outcome.finishReason ? ` finish=${outcome.finishReason}` : ""}${outcome.err ? ` err=${outcome.err}` : ""}`);
  writeJsonl({ ts: new Date().toISOString(), level: "done", type: "request_complete", request: done });
}

// Emergency request-completion if the handler throws before requestCompleted runs.
function requestFailed(req, e) {
  const rec = activeReqs.get(req.reqId);
  if (!rec) return;
  const dur = Date.now() - rec.start;
  activeReqs.delete(req.reqId);
  const done = { ...rec, durMs: dur, status: 502, error: e.message, stack: e.stack };
  writeJsonl({ ts: new Date().toISOString(), level: "error", type: "request_error", request: done });
  // stdout line so the TUI shows it even on unexpected throws
  console.log(`[${new Date().toISOString()}] [error] [${req.reqId}] threw: ${e.message}`);
}

// Capture the full upstream error body to JSONL (the stdout flattens to one
// line, but the audit file keeps the complete provider payload).
function logUpstreamError(req, status, errBody, family) {
  const rec = activeReqs.get(req.reqId);
  writeJsonl({
    ts: new Date().toISOString(),
    level: "error",
    type: "upstream_error",
    reqId: req.reqId,
    model: rec?.model,
    family,
    status,
    body: errBody,
  });
}

// Request ID for per-request tracing
app.use((req, res, next) => {
  req.reqId = crypto.randomUUID().slice(0, 8);
  next();
});

// Token cooldown map — skip rate-limited tokens for a cooling period
const tokenCooldowns = new Map();
const COOLDOWN_MS = 30_000; // 30 seconds

// Accumulated usage counters — surfaced via /health so the TUI can show live
// token in/out without regex-parsing stdout logs.
const STATS = { requests: 0, tokensIn: 0, tokensOut: 0, rtkSavedBytes: 0 };
function trackUsage(usage) {
  if (!usage) return;
  const pin = t => (typeof t === "number" && isFinite(t) && t > 0) ? Math.round(t) : 0;
  STATS.tokensIn += pin(usage.prompt_tokens ?? usage.input_tokens);
  STATS.tokensOut += pin(usage.completion_tokens ?? usage.output_tokens);
}

function detectModelFamily(model) {
  if (!model) return "openai";
  // Use the part after the last "/" for detection (handles "aip/claude-sonnet-4-6")
  const modelPart = model.includes("/") ? model.split("/").pop() : model;
  const m = modelPart.toLowerCase();
  if (m.startsWith("claude")) return "anthropic";
  if (m.startsWith("gpt") || m.startsWith("o1") || m.startsWith("o3")) return "openai";
  if (m.startsWith("gemini")) return "gemini";
  return "openai";
}

function resolveModel(model) {
  if (!model) return null;
  // Take first model if comma-separated list (Hermes fallback etc.)
  const single = model.split(",")[0].trim();
  // Support "tokenname/modelname" syntax.  If the prefix matches a configured
  // token, route to that token.  Otherwise the prefix is still stripped from
  // the model name (common case: user has bare token but passes "aip/gpt-4o").
  let tokenName = null;
  let modelName = single;
  const slash = single.indexOf("/");
  if (slash > 0) {
    const prefix = single.slice(0, slash);
    modelName = single.slice(slash + 1);
    if (CONFIG.tokens.some(t => t.name === prefix)) {
      tokenName = prefix;
    }
  }
  const family = detectModelFamily(modelName);

  // Map model → upstream path + x-llm-model matching Junie CLI's behavior
  // (captured from real Junie requests to Ingrazzio)
  let path, llmModel, streamPath = null;
  if (family === "anthropic") {
    path = "/v1/messages";
    llmModel = "anthropic";
  } else if (family === "gemini") {
    // Junie uses Google Vertex-style path for gemini models
    const base = `/v1beta1/projects/jetbrains-grazie/locations/global/publishers/google/models/${modelName}`;
    path = `${base}:generateContent`;
    streamPath = `${base}:streamGenerateContent?alt=sse`;
    llmModel = "google";
  } else if (modelName.startsWith("deepseek")) {
    // Junie routes deepseek family through /compatible-mode with x-llm-model: alicloud
    path = "/compatible-mode/v1/chat/completions";
    llmModel = "alicloud";
  } else {
    path = "/v1/chat/completions";
    llmModel = "openai";
  }

  return { original: model, modelName, tokenName, family, path, streamPath, llmModel };
}

function getToken(name) {
  if (name) return CONFIG.tokens.find(t => t.name === name)?.token;
  return CONFIG.tokens[0]?.token || "";
}

function applyTokenSavers(body) {
  // Bounded default max output tokens — prevents runaway responses when the
  // client doesn't set a limit. Applies to every family (deepseek passthrough,
  // gemini translator, anthropic translator all read body.max_tokens).
  if (!body.max_tokens && !body.max_completion_tokens && !body.max_output_tokens) {
    body.max_tokens = CONFIG.defaultMaxTokens;
  }
  if (CONFIG.rtkEnabled) {
    const stats = compressMessages(body, { truncate: CONFIG.rtkTruncate });
    const msg = formatRtkLog(stats);
    if (msg) log("rtk", msg);
  }
  if (CONFIG.cavemanEnabled) injectCaveman(body, CONFIG.cavemanLevel);
  if (CONFIG.ponytailEnabled) injectPonytail(body);
  if (CONFIG.headroomEnabled) addHeadroomWarning(body, CONFIG.headroomThreshold);
}

async function tryProxy(path, body, headers, tokenName) {
  if (!CONFIG.tokens.length) return { error: true, status: 400, body: '{"error":"no tokens configured"}' };

  // Try specified token first, then fallback through remaining tokens
  const order = tokenName
    ? [tokenName, ...CONFIG.tokens.filter(t => t.name !== tokenName).map(t => t.name)]
    : CONFIG.tokens.map(t => t.name);

  for (const name of order) {
    // Skip tokens still in cooldown
    const cooldownUntil = tokenCooldowns.get(name);
    if (cooldownUntil && cooldownUntil > Date.now()) {
      log("token", `${name} cooldown (${Math.ceil((cooldownUntil - Date.now()) / 1000)}s remaining), skipping...`);
      continue;
    }
    const token = CONFIG.tokens.find(t => t.name === name)?.token;
    if (!token) continue;
    const h = { ...headers, "Authorization": `Bearer ${token}` };
    try {
      const res = await proxyToIngrazzio(path, body, h);
      if (res.error) {
        if (res.status === 401 || res.status === 429 || res.status === 403) {
          if (res.status === 429) {
            // Use provider-suggested retry-after if given, else the default 30s.
            const ra = res.retryAfterMs || COOLDOWN_MS;
            tokenCooldowns.set(name, Date.now() + ra);
            log("token", `${name} 429, cooling ${Math.round(ra / 1000)}s (retry-after: ${res.retryAfterMs || "default"})`);
          } else {
            log("token", `${name} ${res.status}, trying next...`);
          }
          continue;
        }
        return res;
      }
      log("token", `using ${name}`);
      return res;
    } catch (e) {
      log("token", `${name} error: ${e.message}, trying next...`);
      continue;
    }
  }
  return { error: true, status: 429, body: '{"error":"all tokens exhausted"}' };
}

app.all("/v1/chat/completions", async (req, res) => {
  let body = req.body;
  if (typeof body === "string") {
    try { body = JSON.parse(body); } catch { return res.status(400).json({ error: "invalid json" }); }
  }
  if (!body || !body.model) return res.status(400).json({ error: "model required" });

  // Request timeline — dump model, tools, messages summary (stdout + JSONL).
  const rec = requestStarted(req, body);

  // Shallow-clone to avoid mutating original body (important for retry/debugging)
  body = structuredClone(body);

  const modelInfo = resolveModel(body.model);
  if (!modelInfo) {
    requestCompleted(req, { status: 400, family: detectModelFamily(body.model), err: "unknown model" });
    return res.status(400).json({ error: "unknown model" });
  }
  if (!CONFIG.tokens.length) {
    requestCompleted(req, { status: 400, family: modelInfo.family, err: "no tokens configured" });
    return res.status(400).json({ error: "no tokens configured" });
  }
  rec.family = modelInfo.family;
  rec.llmModel = modelInfo.llmModel;
  rec.token = modelInfo.tokenName || "auto";

  // Track the response outcome automatically when it finishes sending. This
  // catches EVERY path (success, error return, stream end, throw) in one place
  // and records the real status code + duration to stdout + JSONL.
  res.once("finish", () => {
    const status = res.statusCode;
    const rec2 = activeReqs.get(req.reqId);
    if (!rec2) return;
    const outcome = { status, family: rec2.family };
    // Surface useful non-2xx detail in the flat line.
    if (status < 200 || status >= 300) outcome.err = `HTTP ${status}`;
    requestCompleted(req, outcome);
  });

  const isStream = body.stream === true;
  body.model = modelInfo.modelName;

  applyTokenSavers(body);
  const baseHeaders = {
    "User-Agent": CONFIG.junieUserAgent,
    "Grazie-Agent": JSON.stringify({ name: "junie:cli", version: CONFIG.junieVersion }),
    "X-LLM-Model": modelInfo.llmModel,
    "X-Keep-Path": "true",
    "X-Accept-EAP-License": "true",
    "X-Accept-Release-License": "false",
    "X-Client-Execution-Id": "session-" + (() => {
      const d = new Date();
      const pad = n => String(n).padStart(2, "0");
      const rand = Math.random().toString(36).slice(2, 6);
      return `${d.getFullYear().toString().slice(2)}${pad(d.getMonth()+1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}-${rand}`;
    })(),
    "X-Client-Feature-Id": `junie-cli/${CONFIG.junieVersion}`,
    "Accept": "text/event-stream,application/json",
    "Accept-Encoding": "identity",
    "Content-Type": "application/json",
  };

  // Add version headers matching Junie's per-family routing
  if (modelInfo.family === "anthropic") {
    baseHeaders["Anthropic-Version"] = "2023-06-01";
  } else if (modelInfo.family === "gemini") {
    // Google Vertex API doesn't use OpenAI/Anthropic version headers
    // Junie sends no version header for gemini (from capture)
  } else {
    baseHeaders["Openai-Version"] = "2020-11-07";
  }

  try {
    if (modelInfo.family === "anthropic") {
      const anBody = translateOpenAIToAnthropic(body, modelInfo);
      const upstreamRes = await tryProxy(modelInfo.path, anBody, baseHeaders, modelInfo.tokenName);
      if (upstreamRes.error) {
        const errBody = safeParseJson(upstreamRes.body);
        logUpstreamError(req, upstreamRes.status, errBody, modelInfo.family);
        return res.status(upstreamRes.status).json({ error: errBody?.error?.message || errBody?.error || upstreamRes.statusText });
      }
      if (isStream) {
        res.setHeader("Content-Type", "text/event-stream");
        res.setHeader("Cache-Control", "no-cache");
        res.setHeader("Connection", "keep-alive");
        await pipeAnthropicStream(upstreamRes.body, res, modelInfo);
      } else {
        const json = await upstreamRes.json();
        const out = translateAnthropicResponseToOpenAI(json, modelInfo);
        trackUsage(out.usage);
        res.json(out);
      }
    } else if (modelInfo.family === "gemini") {
      const gBody = translateOpenAIToGoogle(body, modelInfo);
      // Streaming uses Vertex SSE endpoint so we can translate each SSE chunk
      const gPath = isStream ? modelInfo.streamPath : modelInfo.path;
      const upstreamRes = await tryProxy(gPath, gBody, baseHeaders, modelInfo.tokenName);
      if (upstreamRes.error) {
        const errBody = safeParseJson(upstreamRes.body);
        logUpstreamError(req, upstreamRes.status, errBody, modelInfo.family);
        return res.status(upstreamRes.status).json({ error: errBody?.error?.message || errBody?.error || upstreamRes.statusText });
      }
      if (isStream) {
        res.setHeader("Content-Type", "text/event-stream");
        res.setHeader("Cache-Control", "no-cache");
        res.setHeader("Connection", "keep-alive");
        await pipeGoogleStream(upstreamRes.body, res, modelInfo);
      } else {
        const json = await upstreamRes.json();
        const out = translateGoogleResponseToOpenAI(json, modelInfo);
        trackUsage(out.usage);
        res.json(out);
      }
    } else {
      if (body.max_tokens && !body.max_completion_tokens) {
        body.max_completion_tokens = body.max_tokens;
        delete body.max_tokens;
      }
      if (isStream) body.stream_options = { include_usage: true };
      const upstreamRes = await tryProxy(modelInfo.path, body, baseHeaders, modelInfo.tokenName);
      if (upstreamRes.error) {
        const errBody = safeParseJson(upstreamRes.body);
        logUpstreamError(req, upstreamRes.status, errBody, modelInfo.family);
        return res.status(upstreamRes.status).json({ error: errBody?.error?.message || errBody?.error || upstreamRes.statusText });
      }
      if (isStream) {
        res.setHeader("Content-Type", "text/event-stream");
        res.setHeader("Cache-Control", "no-cache");
        res.setHeader("Connection", "keep-alive");
        await pipeWebStream(upstreamRes.body, res);
      } else {
        const json = await upstreamRes.json();
        trackUsage(json.usage);
        res.json(json);
      }
    }
    STATS.requests++;
  } catch (e) {
    requestFailed(req, e);
    log("error", "Router error:", e.message);
    if (!res.headersSent) return res.status(502).json({ error: e.message });
    res.end();
  }
});

// --- OpenAI Responses API (/v1/responses) support ---
// Junie CLI's pipeline hits /v1/responses for its classifier and some tools.
// We translate Responses-API input into a chat completion, proxy to the same
// upstream path as /v1/chat/completions, then translate back.
function responsesInputToMessages(input, instructions) {
  const messages = [];
  if (instructions) messages.push({ role: "system", content: typeof instructions === "string" ? instructions : JSON.stringify(instructions) });
  if (typeof input === "string") {
    messages.push({ role: "user", content: input });
  } else if (Array.isArray(input)) {
    for (const item of input) {
      if (item.type === "function_call" || item.type === "function_call_output" || item.type === "reasoning") continue;
      if (item.type === "message" || item.role) {
        const role = item.type === "message" ? (item.role || "user") : (item.role || "user");
        let content = item.content;
        if (Array.isArray(content)) {
          content = content.map(p => p.type === "output_text" || p.type === "input_text" ? p.text : p.type === "text" ? p.text : JSON.stringify(p)).join("");
        }
        messages.push({ role, content });
      } else if (typeof item === "string") {
        messages.push({ role: "user", content: item });
      } else {
        // {role, content} raw form
        messages.push({ role: item.role || "user", content: typeof item.content === "string" ? item.content : JSON.stringify(item.content) });
      }
    }
  }
  if (!messages.some(m => m.role === "user")) messages.push({ role: "user", content: "hi" });
  return messages;
}

function chatToResponsesOutput(openaiJson, modelInfo) {
  const choice = openaiJson.choices && openaiJson.choices[0];
  const msg = choice?.message || {};
  const text = typeof msg.content === "string" ? msg.content : Array.isArray(msg.content) ? msg.content.map(p => p.text || "").join("") : "";
  return {
    id: openaiJson.id || `resp_${Date.now()}`,
    object: "response",
    created_at: openaiJson.created || Math.floor(Date.now() / 1000),
    status: "completed",
    model: modelInfo.modelName,
    output: [
      {
        type: "message",
        id: `msg_${Date.now()}`,
        status: "completed",
        role: "assistant",
        content: [{ type: "output_text", text }],
      },
    ],
    usage: openaiJson.usage ? {
      input_tokens: openaiJson.usage.prompt_tokens || 0,
      output_tokens: openaiJson.usage.completion_tokens || 0,
      total_tokens: openaiJson.usage.total_tokens || 0,
    } : null,
  };
}

app.all("/v1/responses", async (req, res) => {
  const body = typeof req.body === "string" ? safeParseJson(req.body) : req.body;
  if (!body?.model) return res.status(400).json({ error: "model required" });

  // Timeline: stdout + JSONL (same catch-all as /v1/chat/completions).
  const rec = requestStarted(req, body);

  const modelInfo = resolveModel(body.model);
  if (!modelInfo) {
    requestCompleted(req, { status: 400, family: detectModelFamily(body.model), err: "unknown model" });
    return res.status(400).json({ error: "unknown model" });
  }
  if (!CONFIG.tokens.length) {
    requestCompleted(req, { status: 400, family: modelInfo.family, err: "no tokens configured" });
    return res.status(400).json({ error: "no tokens configured" });
  }
  rec.family = modelInfo.family;
  rec.llmModel = modelInfo.llmModel;
  rec.token = modelInfo.tokenName || "auto";
  rec.api = "responses";
  res.once("finish", () => {
    const rec2 = activeReqs.get(req.reqId);
    if (!rec2) return;
    const status = res.statusCode;
    const outcome = { status, family: rec2.family };
    if (status < 200 || status >= 300) outcome.err = `HTTP ${status}`;
    requestCompleted(req, outcome);
  });

  const isStream = body.stream === true;
  // Build a chat-completion-shaped payload the existing family branches understand
  const chatBody = {
    model: modelInfo.modelName,
    messages: responsesInputToMessages(body.input, body.instructions),
    stream: isStream,
  };
  if (body.max_output_tokens) chatBody.max_tokens = body.max_output_tokens;
  if (body.temperature !== undefined) chatBody.temperature = body.temperature;
  if (body.top_p !== undefined) chatBody.top_p = body.top_p;

  applyTokenSavers(chatBody);
  const baseHeaders = {
    "User-Agent": CONFIG.junieUserAgent,
    "Grazie-Agent": JSON.stringify({ name: "junie:cli", version: CONFIG.junieVersion }),
    "X-LLM-Model": modelInfo.llmModel,
    "X-Keep-Path": "true",
    "X-Accept-EAP-License": "true",
    "X-Accept-Release-License": "false",
    "X-Client-Execution-Id": "session-" + (() => { const d = new Date(); const pad = n => String(n).padStart(2, "0"); const rand = Math.random().toString(36).slice(2, 6); return `${d.getFullYear().toString().slice(2)}${pad(d.getMonth()+1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}-${rand}`; })(),
    "X-Client-Feature-Id": `junie-cli/${CONFIG.junieVersion}`,
    "Accept": "text/event-stream,application/json",
    "Accept-Encoding": "identity",
    "Content-Type": "application/json",
  };
  if (modelInfo.family === "anthropic") baseHeaders["Anthropic-Version"] = "2023-06-01";
  else if (modelInfo.family !== "gemini") baseHeaders["Openai-Version"] = "2020-11-07";

  try {
    let upstreamBody, upstreamPath;
    if (modelInfo.family === "anthropic") {
      upstreamBody = translateOpenAIToAnthropic(chatBody, modelInfo);
      upstreamPath = modelInfo.path;
    } else if (modelInfo.family === "gemini") {
      upstreamBody = translateOpenAIToGoogle(chatBody, modelInfo);
      upstreamPath = isStream ? modelInfo.streamPath : modelInfo.path;
    } else {
      if (chatBody.max_tokens && !chatBody.max_completion_tokens) { chatBody.max_completion_tokens = chatBody.max_tokens; delete chatBody.max_tokens; }
      if (isStream) chatBody.stream_options = { include_usage: true };
      upstreamBody = chatBody;
      upstreamPath = modelInfo.path;
    }

    const upstreamRes = await tryProxy(upstreamPath, upstreamBody, baseHeaders, modelInfo.tokenName);
    if (upstreamRes.error) {
      const errBody = safeParseJson(upstreamRes.body);
      logUpstreamError(req, upstreamRes.status, errBody, modelInfo.family);
      return res.status(upstreamRes.status).json({ error: errBody?.error?.message || errBody?.error || upstreamRes.statusText });
    }

    if (isStream) {
      // Translate chat SSE into Responses-API SSE (response.output_text.delta)
      res.setHeader("Content-Type", "text/event-stream");
      res.setHeader("Cache-Control", "no-cache");
      res.setHeader("Connection", "keep-alive");
      const reader = upstreamRes.body.getReader();
      const decoder = new TextDecoder();
      let buf = "";
      const emit = o => { if (!res.writableEnded) res.write(`data: ${JSON.stringify(o)}\n\n`); };
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += decoder.decode(value, { stream: true });
        const lines = buf.split("\n");
        buf = lines.pop() || "";
        for (const line of lines) {
          const t = line.trim();
          if (!t.startsWith("data: ")) continue;
          const d = t.slice(6).trim();
          if (d === "[DONE]") continue;
          let chunk; try { chunk = JSON.parse(d); } catch { continue; }
          const delta = chunk.choices?.[0]?.delta;
          if (delta?.content) {
            emit({ type: "response.output_text.delta", item_id: `msg_${Date.now()}`, output_index: 0, content_index: 0, delta: delta.content });
          }
        }
      }
      emit({ type: "response.completed", response: { id: `resp_${Date.now()}`, object: "response", status: "completed" } });
      if (!res.writableEnded) res.write("data: [DONE]\n\n");
      if (!res.writableEnded) res.end();
    } else {
      let json;
      if (modelInfo.family === "anthropic") {
        const an = await upstreamRes.json();
        json = translateAnthropicResponseToOpenAI(an, modelInfo);
      } else if (modelInfo.family === "gemini") {
        json = translateGoogleResponseToOpenAI(await upstreamRes.json(), modelInfo);
      } else {
        json = await upstreamRes.json();
      }
      trackUsage(json.usage);
      res.json(chatToResponsesOutput(json, modelInfo));
    }
    STATS.requests++;
  } catch (e) {
    requestFailed(req, e);
    log("error", "Responses error:", e.message);
    if (!res.headersSent) return res.status(502).json({ error: e.message });
    res.end();
  }
});

app.get("/health", (req, res) => {
  const breaker = getBreakerState();
  // Check if any tokens are in cooldown
  const tokens = CONFIG.tokens.map(t => {
    const cd = tokenCooldowns.get(t.name);
    return { name: t.name, configured: !!t.token, cooldown: cd && cd > Date.now() ? Math.ceil((cd - Date.now()) / 1000) : 0 };
  });
  const allExhausted = tokens.length > 0 && tokens.every(t => t.cooldown > 0);
  const headers = {};
  if (allExhausted) headers["Retry-After"] = String(Math.min(...tokens.map(t => t.cooldown || 0)) || 30);
  res.set(headers).json({
    status: (allExhausted || breaker.open) ? "degraded" : "ok",
    uptimeSec: Math.round(process.uptime()),
    tokens,
    features: {
      rtk: CONFIG.rtkEnabled,
      rtkTruncate: CONFIG.rtkTruncate,
      defaultMaxTokens: CONFIG.defaultMaxTokens,
      caveman: CONFIG.cavemanEnabled ? CONFIG.cavemanLevel : false,
      ponytail: CONFIG.ponytailEnabled,
      headroom: CONFIG.headroomEnabled,
    },
    ingrazzioUrl: CONFIG.ingrazzioUrl,
    junie: { userAgent: CONFIG.junieUserAgent, version: CONFIG.junieVersion },
    circuit: breaker,
    usage: { requests: STATS.requests, tokensIn: STATS.tokensIn, tokensOut: STATS.tokensOut, rtkSavedBytes: STATS.rtkSavedBytes },
  });
});

// OpenAI-standard model discovery (GET /v1/models). Metadata only — never
// forwarded upstream. Lets omp/yaak/junie enumerate the supported models
// instead of hitting 404 or falling back to hardcoded lists.
app.get("/v1/models", (req, res) => {
  res.json({
    object: "list",
    data: CONFIG.models.map(id => ({
      id,
      object: "model",
      created: 0,
      owned_by: "aip-router",
    })),
  });
});

app.get("/v1/models/:id", (req, res) => {
  const id = req.params.id;
  const found = CONFIG.models.find(m => m === id);
  if (!found) return res.status(404).json({ error: `model '${id}' not found`, object: "error" });
  res.json({ id: found, object: "model", created: 0, owned_by: "aip-router" });
});

async function pipeWebStream(readableStream, res) {
  const reader = readableStream.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  const STREAM_TIMEOUT = 120_000; // 2min idle timeout
  let timeout = setTimeout(() => { try { reader.cancel(); } catch {} if (!res.writableEnded) res.end(); }, STREAM_TIMEOUT);
  // Hidden usage spy — passes bytes through unchanged, but peeks at `data:` SSE
  // lines so streamed deepseek/openai usage can be accumulated (include_usage).
  function peekSse(flush) {
    buffer += flush;
    let idx;
    while ((idx = buffer.indexOf("\n")) >= 0) {
      const line = buffer.slice(0, idx); buffer = buffer.slice(idx + 1);
      const t = line.trim();
      if (!t.startsWith("data:")) continue;
      const payload = t.slice(5).trim();
      if (payload === "[DONE]") continue;
      try {
        const obj = JSON.parse(payload);
        // usage-bearing finish chunk (stream_options.include_usage) or any chunk w/ usage
        if (obj.usage || obj.choices?.[0]?.finish_reason) trackUsage(obj.usage);
      } catch { /* not JSON — ignore */ }
    }
  }
  try {
    while (true) {
      const { done, value } = await reader.read();
      clearTimeout(timeout);
      if (done) { res.end(); return; }
      const str = decoder.decode(value, { stream: true });
      res.write(str);
      peekSse(str);
      timeout = setTimeout(() => { try { reader.cancel(); } catch {} if (!res.writableEnded) res.end(); }, STREAM_TIMEOUT);
    }
  } catch (e) {
    log("error", "pipe stream:", e.message);
    if (!res.writableEnded) res.end();
  } finally {
    clearTimeout(timeout);
  }
}

// Translate Vertex `streamGenerateContent` SSE chunks into OpenAI SSE
// chat.completion.chunk events (deepseek/openai format the client expects).
async function pipeGoogleStream(readableStream, res, modelInfo) {
  const reader = readableStream.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let hasSentFinish = false;
  const STREAM_TIMEOUT = 120_000; // 2min idle timeout
  let timeout = setTimeout(() => { try { reader.cancel(); } catch {} if (!res.writableEnded) res.end(); }, STREAM_TIMEOUT);

  const emit = (obj) => { if (!res.writableEnded) res.write(`data: ${JSON.stringify(obj)}\n\n`); };

  try {
    while (true) {
      const { done, value } = await reader.read();
      clearTimeout(timeout);
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop() || "";
      timeout = setTimeout(() => { try { reader.cancel(); } catch {} if (!res.writableEnded) res.end(); }, STREAM_TIMEOUT);

      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed || !trimmed.startsWith("data:")) continue;
        const data = trimmed.slice(5).trim();
        if (data === "[DONE]") break;
        let chunk;
        try { chunk = JSON.parse(data); } catch { continue; }

        const cand = (chunk.candidates && chunk.candidates[0]) || null;
        // Emit text parts that are NOT thought tokens
        if (cand?.content?.parts) {
          for (const part of cand.content.parts) {
            if (part.text && !part.thought) {
              emit({ choices: [{ index: 0, delta: { content: part.text }, finish_reason: null }] });
            }
          }
        }
        if (cand?.finishReason) {
          const fr = cand.finishReason === "STOP" ? "stop" : cand.finishReason === "MAX_TOKENS" ? "length" : null;
          const um = chunk.promptTokenCount != null || chunk.usageMetadata ? true : false;
          const usage = um ? { prompt_tokens: chunk.promptTokenCount ?? chunk.usageMetadata?.promptTokenCount ?? 0, completion_tokens: chunk.candidates[0]?.tokenCount ?? 0, total_tokens: (chunk.promptTokenCount ?? 0) + (chunk.candidates[0]?.tokenCount ?? 0) } : null;
          emit({ choices: [{ index: 0, delta: {}, finish_reason: fr }], usage });
          if (usage) trackUsage(usage);
          hasSentFinish = true;
        } else if (chunk.usageMetadata && !hasSentFinish) {
          // Some chunks only carry usage; emit a no-op finish so client knows stream continues
          emit({ choices: [{ index: 0, delta: {}, finish_reason: null }] });
          trackUsage({ prompt_tokens: chunk.usageMetadata?.promptTokenCount ?? 0, completion_tokens: chunk.usageMetadata?.candidatesTokenCount ?? chunk.candidates?.[0]?.tokenCount ?? 0 });
        }
      }
    }
  } catch (e) { log("error", "Google SSE:", e.message); }
  finally { clearTimeout(timeout); }

  if (!hasSentFinish) emit({ choices: [{ index: 0, delta: {}, finish_reason: "stop" }], usage: null });
  if (!res.writableEnded) res.write("data: [DONE]\n\n");
  if (!res.writableEnded) res.end();
}

async function pipeAnthropicStream(readableStream, res, modelInfo) {
  const reader = readableStream.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let hasSentFinish = false;
  const STREAM_TIMEOUT = 120_000; // 2min idle timeout
  let timeout = setTimeout(() => { try { reader.cancel(); } catch {} if (!res.writableEnded) res.end(); }, STREAM_TIMEOUT);

  try {
    while (true) {
      const { done, value } = await reader.read();
      clearTimeout(timeout);
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop() || "";
      timeout = setTimeout(() => { try { reader.cancel(); } catch {} if (!res.writableEnded) res.end(); }, STREAM_TIMEOUT);
      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith(":") || trimmed.startsWith("event: ")) continue;
        if (!trimmed.startsWith("data: ")) continue;
        const data = trimmed.slice(6);
        if (data === "[DONE]") {
          if (!hasSentFinish) res.write(`data: ${JSON.stringify({ choices: [{ delta: {}, index: 0, finish_reason: "stop" }], usage: null })}\n\n`);
          res.write("data: [DONE]\n\n");
          res.end(); return;
        }
        let event;
        try { event = JSON.parse(data); } catch { continue; }
        switch (event.type) {
          case "message_start":
            res.write(`data: ${JSON.stringify({ id: event.message?.id || `msg_${Date.now()}`, object: "chat.completion.chunk", created: Math.floor(Date.now() / 1000), model: modelInfo.modelName, choices: [{ index: 0, delta: { role: "assistant" }, finish_reason: null }] })}\n\n`);
            break;
          case "content_block_start":
            if (event.content_block?.type === "text") {
              const text = event.content_block.text || "";
              if (text) res.write(`data: ${JSON.stringify({ choices: [{ index: 0, delta: { content: text }, finish_reason: null }] })}\n\n`);
            } else if (event.content_block?.type === "tool_use") {
              res.write(`data: ${JSON.stringify({ choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: event.content_block.id, type: "function", function: { name: event.content_block.name, arguments: "" } }] }, finish_reason: null }] })}\n\n`);
            }
            break;
          case "content_block_delta":
            if (event.delta?.type === "text_delta") {
              if (event.delta.text) res.write(`data: ${JSON.stringify({ choices: [{ index: 0, delta: { content: event.delta.text }, finish_reason: null }] })}\n\n`);
            } else if (event.delta?.type === "input_json_delta") {
              if (event.delta.partial_json) res.write(`data: ${JSON.stringify({ choices: [{ index: 0, delta: { tool_calls: [{ index: 0, function: { arguments: event.delta.partial_json } }] }, finish_reason: null }] })}\n\n`);
            }
            break;
          case "message_delta":
            { const fr = event.delta?.stop_reason === "end_turn" ? "stop" : event.delta?.stop_reason === "max_tokens" ? "length" : event.delta?.stop_reason === "tool_use" ? "tool_calls" : null;
            const usage = event.usage ? { prompt_tokens: event.usage.input_tokens || 0, completion_tokens: event.usage.output_tokens || 0, total_tokens: (event.usage.input_tokens || 0) + (event.usage.output_tokens || 0) } : null;
            res.write(`data: ${JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: fr }], usage })}\n\n`);
            if (usage) trackUsage(usage);
            hasSentFinish = true; }
            break;
          case "message_stop":
            if (!hasSentFinish) res.write(`data: ${JSON.stringify({ choices: [{ delta: {}, index: 0, finish_reason: "stop" }], usage: null })}\n\n`);
            res.write("data: [DONE]\n\n"); res.end(); return;
          case "error":
            res.write(`data: ${JSON.stringify({ error: event.error?.message || "upstream error" })}\n\n`);
            res.write("data: [DONE]\n\n"); res.end(); return;
        }
      }
    }
  } catch (e) { log("error", "Anthropic SSE:", e.message); }
  finally { clearTimeout(timeout); }
  if (!hasSentFinish) res.write(`data: ${JSON.stringify({ choices: [{ delta: {}, index: 0, finish_reason: "stop" }], usage: null })}\n\n`);
  res.write("data: [DONE]\n\n"); res.end();
}

function translateAnthropicResponseToOpenAI(anBody, modelInfo) {
  const content = [];
  let finishReason = null;
  let usage = { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 };
  if (anBody.content) {
    for (const block of anBody.content) {
      if (block.type === "text") content.push({ type: "text", text: block.text });
      else if (block.type === "tool_use") content.push(block);
    }
  }
  if (anBody.stop_reason === "end_turn") finishReason = "stop";
  else if (anBody.stop_reason === "max_tokens") finishReason = "length";
  else if (anBody.stop_reason === "tool_use") finishReason = "tool_calls";
  if (anBody.usage) {
    usage = { prompt_tokens: anBody.usage.input_tokens || 0, completion_tokens: anBody.usage.output_tokens || 0, total_tokens: (anBody.usage.input_tokens || 0) + (anBody.usage.output_tokens || 0) };
  }
  const msg = { role: "assistant", content: "" };
  msg.content = content.filter(c => c.type === "text").map(c => c.text).join("");
  const toolCalls = content.filter(c => c.type === "tool_use");
  if (toolCalls.length > 0) {
    msg.tool_calls = toolCalls.map(tc => ({ id: tc.id || tc.tool_use_id, type: "function", function: { name: tc.name, arguments: JSON.stringify(tc.input) } }));
  }
  return { id: anBody.id || `msg_${Date.now()}`, object: "chat.completion", created: Math.floor(Date.now() / 1000), model: modelInfo.modelName, choices: [{ index: 0, message: msg, finish_reason: finishReason || "stop" }], usage };
}

const PORT = CONFIG.port;
const httpServer = app.listen(PORT, () => {
  log("info", `\n  AIP Router running at http://localhost:${PORT}`);
  log("info", `  Endpoint: http://localhost:${PORT}/v1/chat/completions`);
  for (const t of CONFIG.tokens) log("info", `  Token: ${t.name} (${!!t.token})`);
  log("info", `  RTK: ${CONFIG.rtkEnabled ? "ON" : "OFF"} | Caveman: ${CONFIG.cavemanEnabled ? CONFIG.cavemanLevel : "OFF"} | Ponytail: ${CONFIG.ponytailEnabled ? "ON" : "OFF"} | Headroom: ${CONFIG.headroomEnabled ? "ON" : "OFF"}\n`);
});

// Graceful shutdown — close server cleanly on SIGTERM/SIGINT
function shutdown(signal) {
  log("info", `Received ${signal}, shutting down gracefully...`);
  httpServer.close(() => {
    log("info", "Server closed");
    process.exit(0);
  });
  // Force exit after 5s if still hanging
  setTimeout(() => { log("warn", "Force exit after timeout"); process.exit(1); }, 5000);
}
process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));
