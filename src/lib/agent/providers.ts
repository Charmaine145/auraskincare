import { toolDefinitions } from "./tools";

/**
 * One small interface over Gemini and OpenAI so the agent loop is provider-agnostic.
 * Keys are read on the server only and never reach the browser bundle.
 */

export interface ToolCall {
  id: string;
  /** ID assigned by the API, echoed back with the function response when present. */
  apiId?: string;
  name: string;
  args: Record<string, unknown>;
}

export type AgentMessage =
  | { role: "user"; text: string }
  | { role: "assistant"; text: string; toolCalls: ToolCall[]; raw?: unknown }
  | { role: "tool"; results: { call: ToolCall; output: Record<string, unknown> }[] };

export interface ModelResponse {
  text: string;
  toolCalls: ToolCall[];
  raw: unknown;
  model: string;
}

export interface ChatProvider {
  name: "Gemini" | "OpenAI";
  model: string;
  chat(input: { system: string[]; messages: AgentMessage[]; signal?: AbortSignal }): Promise<ModelResponse>;
  json<T>(input: { system: string; prompt: string; schema: Record<string, unknown>; signal?: AbortSignal }): Promise<T>;
}

export class ProviderError extends Error {
  constructor(message: string, readonly status?: number) {
    super(message);
  }
}

const TIMEOUT_MS = 15_000;
const withTimeout = (signal?: AbortSignal) => (signal ? AbortSignal.any([signal, AbortSignal.timeout(TIMEOUT_MS)]) : AbortSignal.timeout(TIMEOUT_MS));

function publicError(name: string, status: number): ProviderError {
  if (status === 401 || status === 403) return new ProviderError(`${name} rejected the API key. Add a valid key on the server to restore AI conversation.`, status);
  if (status === 429) return new ProviderError(`${name} has reached its usage limit. Please try again in a moment.`, status);
  return new ProviderError(`${name} is temporarily unavailable. Please try again.`, status);
}

export function modelLabel(model: string): string {
  if (model.startsWith("gpt-")) return model.replace(/^gpt-/, "GPT-").replace(/-mini$/, " mini");
  return model
    .split("-")
    .map(part => (/^\d/.test(part) ? part : part.charAt(0).toUpperCase() + part.slice(1)))
    .join(" ")
    .replace(/Flash Lite/, "Flash-Lite");
}

// ---------------------------------------------------------------- Gemini

type GeminiPart = {
  text?: string;
  thought?: boolean;
  thoughtSignature?: string;
  functionCall?: { id?: string; name: string; args?: Record<string, unknown> };
};

const GEMINI_BASE = "https://generativelanguage.googleapis.com/v1beta/models/";

function geminiThinking(model: string) {
  if (model.startsWith("gemini-2.5-flash")) return { thinkingBudget: 0 };
  if (model.startsWith("gemini-2")) return undefined;
  return { thinkingLevel: process.env.GEMINI_THINKING_LEVEL || "LOW" };
}

function toGeminiContents(messages: AgentMessage[]) {
  return messages.map(message => {
    if (message.role === "user") return { role: "user", parts: [{ text: message.text }] };
    if (message.role === "assistant") {
      // Replaying the model's own parts keeps its thought signatures, which Gemini 3 requires for tool use.
      return { role: "model", parts: (message.raw as GeminiPart[] | undefined) ?? [{ text: message.text }] };
    }
    return {
      role: "user",
      parts: message.results.map(({ call, output }) => ({
        functionResponse: { ...(call.apiId ? { id: call.apiId } : {}), name: call.name, response: output },
      })),
    };
  });
}

function geminiProvider(key: string, model: string): ChatProvider {
  const fallback = process.env.GEMINI_FALLBACK_MODEL || "gemini-3.1-flash-lite";

  async function generate(build: (model: string) => unknown, signal?: AbortSignal) {
    let lastStatus = 0;
    for (const candidate of [...new Set([model, fallback])]) {
      const response = await fetch(`${GEMINI_BASE}${encodeURIComponent(candidate)}:generateContent`, {
        method: "POST",
        headers: { "x-goog-api-key": key, "Content-Type": "application/json" },
        body: JSON.stringify(build(candidate)),
        signal: withTimeout(signal),
      });
      if (response.ok) return { data: await response.json(), model: candidate };
      lastStatus = response.status;
      if (process.env.ARIA_PROVIDER_DEBUG === "1") console.error("Gemini", candidate, response.status, (await response.text()).slice(0, 800));
      // Overload and quota errors are worth one retry on the fallback model; bad requests and auth errors are not.
      if (![429, 500, 503, 504].includes(response.status)) break;
    }
    throw publicError("Gemini", lastStatus);
  }

  return {
    name: "Gemini",
    model,
    async chat({ system, messages, signal }) {
      const { data, model: used } = await generate(candidate => ({
        systemInstruction: { parts: [{ text: system.join("\n\n") }] },
        contents: toGeminiContents(messages),
        tools: [{ functionDeclarations: toolDefinitions.map(t => ({ name: t.name, description: t.description, parametersJsonSchema: t.parameters })) }],
        generationConfig: { temperature: 0.3, maxOutputTokens: 1024, thinkingConfig: geminiThinking(candidate) },
      }), signal);
      const parts: GeminiPart[] = data.candidates?.[0]?.content?.parts ?? [];
      return {
        text: parts.filter(p => p.text && !p.thought).map(p => p.text).join("").trim(),
        toolCalls: parts
          .filter(p => p.functionCall)
          .map((p, i) => ({ id: p.functionCall!.id ?? `call_${i}`, apiId: p.functionCall!.id, name: p.functionCall!.name, args: p.functionCall!.args ?? {} })),
        raw: parts,
        model: used,
      };
    },
    async json<T>({ system, prompt, schema, signal }: { system: string; prompt: string; schema: Record<string, unknown>; signal?: AbortSignal }) {
      const { data } = await generate(candidate => ({
        systemInstruction: { parts: [{ text: system }] },
        contents: [{ role: "user", parts: [{ text: prompt }] }],
        generationConfig: { temperature: 0.2, maxOutputTokens: 1024, responseMimeType: "application/json", responseJsonSchema: schema, thinkingConfig: geminiThinking(candidate) },
      }), signal);
      const text = (data.candidates?.[0]?.content?.parts ?? []).filter((p: GeminiPart) => p.text && !p.thought).map((p: GeminiPart) => p.text).join("");
      return JSON.parse(text) as T;
    },
  };
}

// ---------------------------------------------------------------- OpenAI

function toOpenAiMessages(system: string[], messages: AgentMessage[]) {
  const out: Record<string, unknown>[] = [{ role: "system", content: system.join("\n\n") }];
  for (const message of messages) {
    if (message.role === "user") out.push({ role: "user", content: message.text });
    else if (message.role === "assistant") {
      out.push({
        role: "assistant",
        content: message.text || null,
        ...(message.toolCalls.length
          ? { tool_calls: message.toolCalls.map(call => ({ id: call.id, type: "function", function: { name: call.name, arguments: JSON.stringify(call.args) } })) }
          : {}),
      });
    } else for (const { call, output } of message.results) out.push({ role: "tool", tool_call_id: call.id, content: JSON.stringify(output) });
  }
  return out;
}

function openAiProvider(key: string, model: string): ChatProvider {
  async function post(body: unknown, signal?: AbortSignal) {
    const response = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: withTimeout(signal),
    });
    if (!response.ok) throw publicError("OpenAI", response.status);
    return response.json();
  }
  return {
    name: "OpenAI",
    model,
    async chat({ system, messages, signal }) {
      const data = await post({
        model,
        messages: toOpenAiMessages(system, messages),
        tools: toolDefinitions.map(t => ({ type: "function", function: t })),
        temperature: 0.3,
        max_tokens: 400,
      }, signal);
      const message = data.choices?.[0]?.message ?? {};
      const toolCalls: ToolCall[] = (message.tool_calls ?? []).map((call: { id: string; function: { name: string; arguments: string } }) => {
        let args: Record<string, unknown> = {};
        try { args = JSON.parse(call.function.arguments || "{}"); } catch { /* Invalid JSON is rejected by the tool schema. */ }
        return { id: call.id, name: call.function.name, args };
      });
      return { text: (message.content ?? "").trim(), toolCalls, raw: message, model };
    },
    async json<T>({ system, prompt, schema, signal }: { system: string; prompt: string; schema: Record<string, unknown>; signal?: AbortSignal }) {
      const data = await post({
        model,
        messages: [{ role: "system", content: system }, { role: "user", content: prompt }],
        response_format: { type: "json_schema", json_schema: { name: "call_summary", strict: true, schema } },
        temperature: 0.2,
      }, signal);
      return JSON.parse(data.choices?.[0]?.message?.content ?? "") as T;
    },
  };
}

/** Gemini is preferred when configured; OpenAI is an alternative; null means rule-based demo mode. */
export function getProvider(): ChatProvider | null {
  if (process.env.GEMINI_API_KEY) return geminiProvider(process.env.GEMINI_API_KEY, process.env.GEMINI_MODEL || "gemini-3.5-flash-lite");
  if (process.env.OPENAI_API_KEY) return openAiProvider(process.env.OPENAI_API_KEY, process.env.OPENAI_MODEL || "gpt-4o-mini");
  return null;
}
