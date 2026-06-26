import { CONFIG } from "./config.js";

const INGRAZZIO_BASE = CONFIG.ingrazzioUrl;

export async function proxyToIngrazzio(path, body, headers) {
  const url = `${INGRAZZIO_BASE}${path}`;
  const response = await fetch(url, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
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
        input: JSON.parse(tc.function?.arguments || tc.arguments || "{}"),
      });
    }
  }
  return { role: "assistant", content };
}

// Anthropic SSE → OpenAI SSE streaming translation
export function translateAnthropicSSEToOpenAI(upstreamStream, res, modelInfo) {
  let buffer = "";
  let pendingContent = "";
  let contentBlockIndex = 0;
  let hasSentStart = false;
  let hasSentFinish = false;

  upstreamStream.on("data", chunk => {
    buffer += chunk.toString();
    const lines = buffer.split("\n");
    buffer = lines.pop() || "";

    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith(":")) continue;

      if (trimmed.startsWith("event: ")) continue; // handled by data line
      if (!trimmed.startsWith("data: ")) continue;

      const data = trimmed.slice(6);
      if (data === "[DONE]") {
        if (!hasSentFinish) {
          res.write(`data: ${JSON.stringify({ choices: [{ delta: {}, index: 0, finish_reason: "stop" }], usage: null })}\n\n`);
          hasSentFinish = true;
        }
        res.write("data: [DONE]\n\n");
        res.end();
        return;
      }

      let event;
      try { event = JSON.parse(data); } catch { continue; }

      switch (event.type) {
        case "message_start": {
          hasSentStart = true;
          res.write(`data: ${JSON.stringify({
            id: event.message?.id || `msg_${Date.now()}`,
            object: "chat.completion.chunk",
            created: Math.floor(Date.now() / 1000),
            model: modelInfo.original,
            choices: [{ index: 0, delta: { role: "assistant" }, finish_reason: null }],
          })}\n\n`);
          break;
        }
        case "content_block_start": {
          contentBlockIndex = event.index || 0;
          if (event.content_block?.type === "text") {
            pendingContent = event.content_block.text || "";
            if (pendingContent) {
              res.write(`data: ${JSON.stringify({
                choices: [{ index: 0, delta: { content: pendingContent }, finish_reason: null }],
              })}\n\n`);
            }
          } else if (event.content_block?.type === "tool_use") {
            res.write(`data: ${JSON.stringify({
              choices: [{
                index: 0,
                delta: {
                  tool_calls: [{
                    index: 0,
                    id: event.content_block.id,
                    type: "function",
                    function: { name: event.content_block.name, arguments: "" },
                  }],
                },
                finish_reason: null,
              }],
            })}\n\n`);
          }
          break;
        }
        case "content_block_delta": {
          if (event.delta?.type === "text_delta") {
            const text = event.delta.text;
            if (text) {
              res.write(`data: ${JSON.stringify({
                choices: [{ index: 0, delta: { content: text }, finish_reason: null }],
              })}\n\n`);
            }
          } else if (event.delta?.type === "input_json_delta") {
            const partial = event.delta.partial_json || "";
            if (partial) {
              res.write(`data: ${JSON.stringify({
                choices: [{
                  index: 0,
                  delta: {
                    tool_calls: [{
                      index: 0,
                      function: { arguments: partial },
                    }],
                  },
                  finish_reason: null,
                }],
              })}\n\n`);
            }
          }
          break;
        }
        case "message_delta": {
          let finishReason = null;
          if (event.delta?.stop_reason === "end_turn") finishReason = "stop";
          else if (event.delta?.stop_reason === "max_tokens") finishReason = "length";
          else if (event.delta?.stop_reason === "tool_use") finishReason = "tool_calls";

          const usage = event.usage ? {
            prompt_tokens: event.usage.input_tokens || 0,
            completion_tokens: event.usage.output_tokens || 0,
            total_tokens: (event.usage.input_tokens || 0) + (event.usage.output_tokens || 0),
          } : null;

          res.write(`data: ${JSON.stringify({
            choices: [{ index: 0, delta: {}, finish_reason: finishReason }],
            usage,
          })}\n\n`);
          hasSentFinish = true;
          break;
        }
        case "message_stop": {
          if (!hasSentFinish) {
            res.write(`data: ${JSON.stringify({ choices: [{ delta: {}, index: 0, finish_reason: "stop" }], usage: null })}\n\n`);
            hasSentFinish = true;
          }
          res.write("data: [DONE]\n\n");
          res.end();
          return;
        }
        case "ping":
          break; // ignore
        case "error": {
          res.write(`data: ${JSON.stringify({ error: event.error?.message || "upstream error" })}\n\n`);
          res.write("data: [DONE]\n\n");
          res.end();
          return;
        }
      }
    }
  });

  upstreamStream.on("end", () => {
    if (!hasSentFinish) {
      res.write(`data: ${JSON.stringify({ choices: [{ delta: {}, index: 0, finish_reason: "stop" }], usage: null })}\n\n`);
    }
    res.write("data: [DONE]\n\n");
    res.end();
  });

  upstreamStream.on("error", err => {
    console.error("[SSE] stream error:", err.message);
    if (!res.writableEnded) {
      res.write(`data: ${JSON.stringify({ choices: [{ delta: {}, index: 0, finish_reason: "stop" }], usage: null })}\n\n`);
      res.write("data: [DONE]\n\n");
      res.end();
    }
  });
}
