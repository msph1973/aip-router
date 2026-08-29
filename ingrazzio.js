import { CONFIG } from "./config.js";
import { safeParseJson } from "./util.js";

const INGRAZZIO_BASE = CONFIG.ingrazzioUrl;

// --- Circuit breaker state (exported for /health) ---
const BREAKER = {
  failures: 0,          // consecutive network failures
  lastFailAt: 0,        // ts of last network failure
  openUntil: 0,         // ts when circuit reopens for probing
  totalRequests: 0,
  totalNetworkErrors: 0,
};
const BREAKER_THRESHOLD = 5;   // open after 5 consecutive network errors
const BREAKER_COOLDOWN_MS = 15_000; // reopen for a probe after 15s

export function getBreakerState() {
  return {
    ...BREAKER,
    open: Date.now() < BREAKER.openUntil,
    // time remaining until a probe is allowed (0 if closed)
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

// Retry on transient network errors (fetch failed / ECONNRESET / socket hang up).
// For streaming, retry doesn't make sense mid-stream; only retry connection errors.
export async function proxyToIngrazzio(path, body, headers, retries = 3) {
  const url = `${INGRAZZIO_BASE}${path}`;
  const isStream = body.stream === true;
  const timeout = isStream ? 600_000 : 120_000; // 10min stream, 2min non-stream

  // Fail fast while the circuit is open (unless probing: let the first call through).
  if (Date.now() < BREAKER.openUntil) {
    return circuitErr(BREAKER.failures);
  }

  let lastErr;
  for (let attempt = 1; attempt <= retries; attempt++) {
    BREAKER.totalRequests += 1;
    try {
      const response = await fetch(url, {
        method: "POST",
        headers,
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(timeout),
      });
      if (!response.ok) {
        // tryProxy checks `res.error` truthy + `res.body` text
        const text = await response.text();
        console.error(`[Ingrazzio] ${response.status} ${response.statusText}: ${text.slice(0, 500)}`);
        return {
          error: true,
          status: response.status,
          statusText: response.statusText,
          body: text,
          text: async () => text,
          json: async () => { try { return JSON.parse(text); } catch { return null; } },
        };
      }
      // Success — reset failure streak
      BREAKER.failures = 0;
      return response;
    } catch (e) {
      lastErr = e;
      recordFailure();
      const code = e.cause?.code || e.cause?.message || "n/a";
      console.error(`[proxy] attempt ${attempt}/${retries} failed: ${e.message} (cause: ${code})`);
      if (Date.now() >= BREAKER.openUntil && attempt < retries) await new Promise((r) => setTimeout(r, 500 * attempt));
    }
  }
  throw lastErr || new Error("proxyToIngrazzio failed");
}

// OpenAI → Anthropic format translation
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

  // Translate tools from OpenAI format to Anthropic format
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

// OpenAI → Google Vertex (generateContent) format translation
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

