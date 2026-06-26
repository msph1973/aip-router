import express from "express";
import crypto from "crypto";
import { CONFIG } from "./config.js";
import { compressMessages, formatRtkLog } from "./rtk/index.js";
import { injectCaveman } from "./prompts/caveman.js";
import { injectPonytail } from "./prompts/ponytail.js";
import { addHeadroomWarning } from "./headroom.js";
import { proxyToIngrazzio, translateOpenAIToAnthropic } from "./ingrazzio.js";
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

// Structured logging with timestamps
function log(level, ...args) {
  const ts = new Date().toISOString();
  console.log(`[${ts}] [${level}]`, ...args);
}

// Request ID for per-request tracing
app.use((req, res, next) => {
  req.reqId = crypto.randomUUID().slice(0, 8);
  next();
});

// Token cooldown map — skip rate-limited tokens for a cooling period
const tokenCooldowns = new Map();
const COOLDOWN_MS = 30_000; // 30 seconds

function detectModelFamily(model) {
  if (!model) return "openai";
  const m = model.toLowerCase();
  if (m.startsWith("claude")) return "anthropic";
  if (m.startsWith("gpt") || m.startsWith("o1") || m.startsWith("o3")) return "openai";
  if (m.startsWith("gemini")) return "gemini";
  return "openai";
}

function resolveModel(model) {
  if (!model) return null;
  // Take first model if comma-separated list (Hermes fallback etc.)
  const single = model.split(",")[0].trim();
  // Support "tokenname/modelname" syntax
  let tokenName = null;
  let modelName = single;
  const slash = single.indexOf("/");
  if (slash > 0) {
    const prefix = single.slice(0, slash);
    if (CONFIG.tokens.some(t => t.name === prefix)) {
      tokenName = prefix;
      modelName = single.slice(slash + 1);
    }
  }
  const family = detectModelFamily(modelName);
  return {
    original: model, modelName, tokenName,
    family,
    path: family === "anthropic" ? "/v1/messages" : "/v1/chat/completions",
    llmModel: family === "anthropic" ? "anthropic" : family === "gemini" ? "google" : "openai",
  };
}

function getToken(name) {
  if (name) return CONFIG.tokens.find(t => t.name === name)?.token;
  return CONFIG.tokens[0]?.token || "";
}

function applyTokenSavers(body) {
  if (CONFIG.rtkEnabled) {
    const stats = compressMessages(body);
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
          if (res.status === 429) tokenCooldowns.set(name, Date.now() + COOLDOWN_MS);
          log("token", `${name} ${res.status}, trying next...`);
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

  // Shallow-clone to avoid mutating original body (important for retry/debugging)
  body = structuredClone(body);

  const modelInfo = resolveModel(body.model);
  if (!modelInfo) return res.status(400).json({ error: "unknown model" });
  if (!CONFIG.tokens.length) return res.status(400).json({ error: "no tokens configured" });

  const isStream = body.stream === true;
  body.model = modelInfo.modelName;

  applyTokenSavers(body);
  const baseHeaders = {
    "X-LLM-Model": modelInfo.llmModel,
    "X-Keep-Path": "true",
    "X-Accept-EAP-License": "true",
    "X-Accept-Release-License": "true",
    "Content-Type": "application/json",
    "User-Agent": "aip-router/1.0",
  };

  try {
    if (modelInfo.family === "anthropic") {
      const anBody = translateOpenAIToAnthropic(body, modelInfo);
      const upstreamRes = await tryProxy(modelInfo.path, anBody, baseHeaders, modelInfo.tokenName);
      if (upstreamRes.error) {
        const errBody = safeParseJson(upstreamRes.body);
        return res.status(upstreamRes.status).json({ error: errBody?.error?.message || errBody?.error || upstreamRes.statusText });
      }
      if (isStream) {
        res.setHeader("Content-Type", "text/event-stream");
        res.setHeader("Cache-Control", "no-cache");
        res.setHeader("Connection", "keep-alive");
        await pipeAnthropicStream(upstreamRes.body, res, modelInfo);
      } else {
        const json = await upstreamRes.json();
        res.json(translateAnthropicResponseToOpenAI(json, modelInfo));
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
        return res.status(upstreamRes.status).json({ error: errBody?.error?.message || errBody?.error || upstreamRes.statusText });
      }
      if (isStream) {
        res.setHeader("Content-Type", "text/event-stream");
        res.setHeader("Cache-Control", "no-cache");
        res.setHeader("Connection", "keep-alive");
        await pipeWebStream(upstreamRes.body, res);
      } else {
        res.json(await upstreamRes.json());
      }
    }
  } catch (e) {
    log("error", "Router error:", e.message);
    if (!res.headersSent) return res.status(502).json({ error: e.message });
    res.end();
  }
});

app.get("/health", (req, res) => {
  // Check if any tokens are in cooldown
  const tokens = CONFIG.tokens.map(t => {
    const cd = tokenCooldowns.get(t.name);
    return { name: t.name, configured: !!t.token, cooldown: cd && cd > Date.now() ? Math.ceil((cd - Date.now()) / 1000) : 0 };
  });
  const allExhausted = tokens.length > 0 && tokens.every(t => t.cooldown > 0);
  const headers = {};
  if (allExhausted) headers["Retry-After"] = String(Math.min(...tokens.map(t => t.cooldown || 0)) || 30);
  res.set(headers).json({
    status: allExhausted ? "degraded" : "ok",
    tokens,
    features: {
      rtk: CONFIG.rtkEnabled,
      caveman: CONFIG.cavemanEnabled ? CONFIG.cavemanLevel : false,
      ponytail: CONFIG.ponytailEnabled,
      headroom: CONFIG.headroomEnabled,
    },
    ingrazzioUrl: CONFIG.ingrazzioUrl,
  });
});

async function pipeWebStream(readableStream, res) {
  const reader = readableStream.getReader();
  const decoder = new TextDecoder();
  const STREAM_TIMEOUT = 120_000; // 2min idle timeout
  let timeout = setTimeout(() => { try { reader.cancel(); } catch {} if (!res.writableEnded) res.end(); }, STREAM_TIMEOUT);
  try {
    while (true) {
      const { done, value } = await reader.read();
      clearTimeout(timeout);
      if (done) { res.end(); return; }
      res.write(decoder.decode(value, { stream: true }));
      timeout = setTimeout(() => { try { reader.cancel(); } catch {} if (!res.writableEnded) res.end(); }, STREAM_TIMEOUT);
    }
  } catch (e) {
    log("error", "pipe stream:", e.message);
    if (!res.writableEnded) res.end();
  } finally {
    clearTimeout(timeout);
  }
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
