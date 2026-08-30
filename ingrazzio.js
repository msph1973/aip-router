import { CONFIG } from "./config.js";
import { safeParseJson } from "./util.js";
import https from "node:https";
import { Readable } from "node:stream";

const INGRAZZIO_BASE = CONFIG.ingrazzioUrl;

// --- Circuit breaker state (exported for /health) ---
const BREAKER = {
  failures: 0,
  lastFailAt: 0,
  openUntil: 0,
  totalRequests: 0,
  totalNetworkErrors: 0,
};
const BREAKER_THRESHOLD = 5;
const BREAKER_COOLDOWN_MS = 15_000;
const BREAKER_429_THRESHOLD = 3;
const BREAKER_429_COOLDOWN_MS = 30_000;

export function getBreakerState() {
  return {
    ...BREAKER,
    open: Date.now() < BREAKER.openUntil,
    reopenInMs: Math.max(0, BREAKER.openUntil - Date.now()),
  };
}

function recordFailure() {
  BREAKER.failures += 1;
  BREAKER.lastFailAt = Date.now();
  BREAKER.totalNetworkErrors += 1;
  if (BREAKER.failures >= BREAKER_THRESHOLD) {
    BREAKER.openUntil = Date.now() + BREAKER_COOLDOWN_MS;
  }
}

function record429Failure() {
  BREAKER._429failures = (BREAKER._429failures || 0) + 1;
  if (BREAKER._429failures >= BREAKER_429_THRESHOLD) {
    BREAKER.openUntil = Date.now() + BREAKER_429_COOLDOWN_MS;
    BREAKER.failures = BREAKER_THRESHOLD;
    console.error(`[circuit] 429 storm detected, circuit open for ${BREAKER_429_COOLDOWN_MS}ms`);
  }
}

function circuitErr(attempts) {
  return {
    error: true,
    status: 503,
    statusText: "circuit open — upstream unreachable",
    circuitOpen: true,
    body: JSON.stringify({ error: `Upstream unreachable (${attempts} consecutive failures). Circuit open.` }),
    text: async () => JSON.stringify({ error: "upstream unreachable" }),
    json: async () => ({ error: "upstream unreachable" }),
  };
}

// Wrap a node http.IncomingMessage into a WHATWG-Response-like object so the
// existing caller code (server.js) keeps working unchanged: .ok/.status/
// .statusText/.headers, lazy .body (Readable.toWeb), .text()/.json().
//
// WHY node:https instead of global fetch: on some environments (Ubuntu VPS,
// node 22/25) undici's global fetch fails every request with
// "invalid onRequestStart method" / "fetch failed" even though curl and
// node:https work fine. Using node:https sidesteps undici entirely.
function wrapIncomingMessage(res, statusText) {
  let webBody = null;
  const bodyStream = () => {
    if (!webBody) webBody = Readable.toWeb(res);
    return webBody;
  };
  return {
    ok: res.statusCode >= 200 && res.statusCode < 300,
    status: res.statusCode,
    statusText: statusText || res.statusMessage || "",
    headers: res.headers,
    url: INGRAZZIO_BASE,
    get body() { return bodyStream(); },
    text: async () => {
      const chunks = [];
      for await (const chunk of res) chunks.push(chunk);
      return Buffer.concat(chunks).toString("utf8");
    },
    json: async () => {
      const chunks = [];
      for await (const chunk of res) chunks.push(chunk);
      const t = Buffer.concat(chunks).toString("utf8");
      try { return JSON.parse(t); } catch { return null; }
    },
  };
}

// Perform the HTTPS POST to Ingrazzio. Returns a promise resolving to
// { res } so callers can pick either the raw stream or the wrapped view.
// Body streaming (SSE) stays intact: we hand the raw IncomingMessage to
// the caller; nothing is buffered.
function doHttpsPost(path, body, headers, timeoutMs) {
  const url = new URL(`${INGRAZZIO_BASE}${path}`);
  const payload = JSON.stringify(body);
  return new Promise((resolve, reject) => {
    const req = https.request(
      {
        hostname: url.hostname,
        port: url.port || 443,
        path: url.pathname + url.search,
        method: "POST",
        headers: {
          ...headers,
          "Content-Type": "application/json",
          "Content-Length": Buffer.byteLength(payload),
        },
        timeout: timeoutMs,
      },
      (res) => resolve({ res })
    );
    req.on("timeout", () => { req.destroy(new Error(`timeout after ${timeoutMs}ms`)); });
    req.on("error", (e) => reject(e));
    req.write(payload);
    req.end();
  });
}

// Helper: safe text extraction from wrapper
async function extractText(wrapper) {
  return await wrapper.text();
}

// Translate Vertex generateContent response to OpenAI format
export function translateGoogleResponseToOpenAI(gBody, modelInfo) {
  const candidate = gBody.candidates?.[0];
  const parts = candidate?.content?.parts || [];
  const text = parts
    .filter(p => p.text && !p.thought)
    .map(p => p.text)
    .join("");
  const finishReason = candidate?.finishReason === "STOP" ? "stop"
    : candidate?.finishReason === "MAX_TOKENS" ? "length" : "stop";
  const usage = gBody.usageMetadata ? {
    prompt_tokens: gBody.usageMetadata.promptTokenCount || 0,
    completion_tokens: gBody.usageMetadata.candidatesTokenCount || 0,
    total_tokens: (gBody.usageMetadata.promptTokenCount || 0) + (gBody.usageMetadata.candidatesTokenCount || 0),
  } : { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 };
  return {
    id: `chatcmpl-${Date.now()}`,
    object: "chat.completion",
    created: Math.floor(Date.now() / 1000),
    model: modelInfo.modelName,
    choices: [{ index: 0, message: { role: "assistant", content: text }, finish_reason: finishReason }],
    usage,
  };
}

// Proxy to Ingrazzio over native node:https. Retries transient network
// errors with exponential backoff + jitter; tracks 429 storms; parses the
// provider's Retry-After / "wait Xms" so callers can cool down adaptively.
export async function proxyToIngrazzio(path, body, headers, retries = 3) {
  const isStream = body.stream === true;
  const timeout = isStream ? 600_000 : 120_000;

  // Fail fast while the circuit is open (unless probing: let the first call through).
  if (Date.now() < BREAKER.openUntil) {
    return circuitErr(BREAKER.failures);
  }

  let lastErr;
  for (let attempt = 1; attempt <= retries; attempt++) {
    BREAKER.totalRequests += 1;
    try {
      const { res } = await doHttpsPost(path, body, headers, timeout);
      const wrapper = wrapIncomingMessage(res, res.statusMessage);
      if (!res.statusCode || res.statusCode >= 400) {
        const upText = await extractText(wrapper);
        console.error(`[Ingrazzio] ${res.statusCode} ${res.statusMessage}: ${upText.slice(0, 500)}`);
        // 429 handling: record failure; parse Retry-After / wait-ms so the
        // caller (server.js) can cool that token down for the right amount.
        if (res.statusCode === 429) {
          record429Failure();
          let retryAfter = 30_000; // default 30s
          const ra = res.headers["retry-after"];
          if (ra) {
            retryAfter = typeof ra === "number" ? ra : parseInt(ra, 10) * 1000;
          }
          // Also check body for "wait Xms" patterns
          const msMatch = upText.match(/(\d+)\s*ms/i);
          if (msMatch) {
            const parsed = parseInt(msMatch[1], 10);
            if (parsed > 0 && parsed < 600_000) retryAfter = parsed;
          }
          return {
            error: true,
            status: 429,
            statusText: "429 Too Many Requests",
            body: upText,
            retryAfterMs: Math.min(retryAfter, 300_000), // cap at 5min
          };
        }
        return {
          error: true,
          status: res.statusCode,
          statusText: res.statusMessage || "",
          body: upText,
        };
      }
      // Success — reset failure streaks
      BREAKER.failures = 0;
      BREAKER._429failures = 0;
      return wrapper; // .ok true, .body web stream, .json()/.text() work
    } catch (e) {
      lastErr = e;
      recordFailure();
      const code = e.code || e.message || "n/a";
      console.error(`[proxy] attempt ${attempt}/${retries} failed: ${e.message} (cause: ${code})`);
      if (Date.now() >= BREAKER.openUntil && attempt < retries) {
        // Exponential backoff with jitter: 500ms * 2^attempt + random(0,1s)
        const backoff = Math.min(500 * 2 ** attempt, 30_000) + Math.random() * 1000;
        await new Promise((r) => setTimeout(r, backoff));
      }
    }
  }
  throw lastErr || new Error("proxyToIngrazzio failed");
}

// OpenAI to Anthropic format translation
export function translateOpenAIToAnthropic(body, modelInfo) {
  const anBody = {
    model: body.model,
    max_tokens: body.max_tokens || 2048,
    stream: body.stream === true,
  };
  if (body.temperature !== undefined) anBody.temperature = body.temperature;
  if (body.top_p !== undefined) anBody.top_p = body.top_p;
  if (body.stop) anBody.stop_sequences = Array.isArray(body.stop) ? body.stop : [body.stop];
  if (body.metadata) anBody.metadata = body.metadata;

  const messages = [];
  let system = "";

  for (const msg of body.messages || []) {
    if (msg.role === "system") {
      system += (system ? "\n\n" : "") + extractTextContent(msg);
      continue;
    }
    if (msg.role === "tool") {
      messages.push(translateToolToAnthropic(msg));
      continue;
    }
    if (msg.role === "assistant" && msg.tool_calls) {
      messages.push(translateAssistantWithToolsToAnthropic(msg));
      continue;
    }
    messages.push({
      role: msg.role,
      content: translateContentToAnthropic(msg.content),
    });
  }

  if (system) anBody.system = system;
  anBody.messages = messages.length > 0 ? messages : [{ role: "user", content: "hello" }];

  if (body.tools) {
    anBody.tools = body.tools.map(t => {
      if (t.type === "function" && t.function) {
        return {
          name: t.function.name,
          description: t.function.description || "",
          input_schema: t.function.parameters || {},
        };
      }
      return t;
    });
  }

  return anBody;
}

function extractTextContent(msg) {
  if (typeof msg.content === "string") return msg.content;
  if (Array.isArray(msg.content)) {
    return msg.content.filter(p => p.type === "text").map(p => p.text).join("\n");
  }
  return "";
}

function translateContentToAnthropic(content) {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content.map(part => {
      if (part.type === "text") return { type: "text", text: part.text };
      if (part.type === "image_url") {
        return { type: "image", source: { type: "base64", media_type: "image/jpeg", data: part.image_url?.url?.replace(/^data:image\/\w+;base64,/, "") || "" } };
      }
      return part;
    });
  }
  return String(content);
}

function translateToolToAnthropic(msg) {
  const content = [{ type: "tool_result", tool_use_id: msg.tool_call_id || "", content: typeof msg.content === "string" ? msg.content : JSON.stringify(msg.content), is_error: false }];
  return { role: "user", content };
}

function translateAssistantWithToolsToAnthropic(msg) {
  const content = [];
  if (typeof msg.content === "string" && msg.content) content.push({ type: "text", text: msg.content });
  else if (Array.isArray(msg.content)) {
    for (const part of msg.content) {
      if (part.type === "text") content.push({ type: "text", text: part.text });
    }
  }
  if (msg.tool_calls) {
    for (const tc of msg.tool_calls) {
      content.push({
        type: "tool_use",
        id: tc.id || tc.tool_use_id,
        name: tc.function?.name || tc.name,
        input: safeParseJson(tc.function?.arguments || tc.arguments, {}),
      });
    }
  }
  return { role: "assistant", content };
}

// OpenAI to Google Vertex (generateContent) format translation
export function translateOpenAIToGoogle(body, modelInfo) {
  const contents = [];
  let systemInstruction = "";

  for (const msg of body.messages || []) {
    if (msg.role === "system") {
      systemInstruction += (systemInstruction ? "\n\n" : "") + extractTextContent(msg);
      continue;
    }
    if (msg.role === "tool") {
      contents.push({
        role: "user",
        parts: [{ text: typeof msg.content === "string" ? msg.content : JSON.stringify(msg.content) }],
      });
      continue;
    }
    const parts = [];
    if (typeof msg.content === "string") {
      parts.push({ text: msg.content });
    } else if (Array.isArray(msg.content)) {
      for (const p of msg.content) {
        if (p.type === "text") parts.push({ text: p.text });
        else if (p.type === "image_url") {
          const data = p.image_url?.url?.replace(/^data:image\/\w+;base64,/, "") || "";
          parts.push({ inline_data: { mime_type: "image/jpeg", data } });
        }
      }
    }
    contents.push({ role: msg.role === "assistant" ? "model" : "user", parts });
  }

  const generationConfig = {};
  if (body.max_tokens) generationConfig.maxOutputTokens = body.max_tokens;
  if (body.temperature !== undefined) generationConfig.temperature = body.temperature;
  if (body.top_p !== undefined) generationConfig.topP = body.top_p;
  if (body.stop) generationConfig.stopSequences = Array.isArray(body.stop) ? body.stop : [body.stop];

  const gBody = { contents };
  if (systemInstruction) gBody.systemInstruction = { parts: [{ text: systemInstruction }] };
  if (Object.keys(generationConfig).length > 0) gBody.generationConfig = generationConfig;

  return gBody;
}