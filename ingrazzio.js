import { CONFIG } from "./config.js";

const INGRAZZIO_BASE = CONFIG.ingrazzioUrl;

export async function proxyToIngrazzio(path, body, headers) {
  const url = `${INGRAZZIO_BASE}${path}`;
  const isStream = body.stream === true;
  const timeout = isStream ? 600_000 : 120_000; // 10min stream, 2min non-stream
  const response = await fetch(url, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(timeout),
  });
  if (!response.ok) {
    const text = await response.text();
    console.error(`[Ingrazzio] ${response.status} ${response.statusText}: ${text.slice(0, 500)}`);
    return { error: true, status: response.status, statusText: response.statusText, body: text };
  }
  return response;
}

// OpenAI → Anthropic format translation
export function translateOpenAIToAnthropic(body, modelInfo) {
  const anBody = {
    model: body.model,
    max_tokens: body.max_tokens || 8192,
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

  // Add tools if present
  if (body.tools) anBody.tools = body.tools;

  return anBody;
}

function extractTextContent(msg) {
  if (typeof msg.content === "string") return msg.content;
  if (Array.isArray(msg.content)) {
    return msg.content.filter(p => p.type === "text").map(p => p.text).join("\n");
  }
  return "";
}

function safeParseJson(str, fallback) {
  try { return JSON.parse(str); } catch { return fallback; }
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

