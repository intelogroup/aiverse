import { env } from "@aiverse/shared/env";
import { log } from "../util/log";

export interface LLMProvider {
  complete(params: { system: string; messages: { role: string; content: string }[] }): Promise<string | null>;
}

// One cheap model shared by every native agent — personality/objective comes
// from the system prompt, not the model, so behavior differences measure
// personality/memory, not model capability. Fallback tried in order on
// non-2xx (rate limit, provider-not-allowed, upstream outage) — both entries
// verified live against this account's provider allow-list before wiring.
const MODELS = ["google/gemini-2.5-flash-lite", "meta-llama/llama-3.1-8b-instruct", "deepseek/deepseek-v4-flash"];

export class OpenRouterProvider implements LLMProvider {
  async complete(params: { system: string; messages: { role: string; content: string }[] }): Promise<string | null> {
    if (!env.OPENROUTER_API_KEY) return null;
    for (const model of MODELS) {
      try {
        const res = await fetch("https://openrouter.ai/api/v1/chat/completions", {
          method: "POST",
          headers: {
            Authorization: `Bearer ${env.OPENROUTER_API_KEY}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            model,
            messages: [{ role: "system", content: params.system }, ...params.messages],
            max_tokens: 300,
          }),
        });
        if (!res.ok) {
          log("llm_error", { model, status: res.status, body: (await res.text()).slice(0, 300) });
          continue;
        }
        const data: any = await res.json();
        return data?.choices?.[0]?.message?.content ?? null;
      } catch (e) {
        log("llm_error", { model, error: String(e) });
      }
    }
    return null;
  }
}

// Local Ollama backend for small-scale experiment runs when no paid provider
// is reachable (OpenAI key invalid, OpenRouter out of credits). Uses the
// NATIVE /api/chat endpoint (not OpenAI-compat) because the local qwen3/gemma
// builds are thinking models: only `think: false` on /api/chat emits the
// decision JSON directly in `content` — the compat endpoint burns the whole
// token budget in `reasoning` and returns empty content. Verified live 2026-08-31.
export class OllamaProvider implements LLMProvider {
  async complete(params: { system: string; messages: { role: string; content: string }[] }): Promise<string | null> {
    const baseUrl = process.env.OLLAMA_BASE_URL ?? "http://127.0.0.1:11434";
    const model = process.env.OLLAMA_MODEL ?? "qwen3:8b";
    try {
      const res = await fetch(`${baseUrl}/api/chat`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          model,
          messages: [{ role: "system", content: params.system }, ...params.messages],
          stream: false,
          think: false,
          options: { num_predict: 300 },
        }),
      });
      if (!res.ok) {
        log("llm_error", { provider: "ollama", model, status: res.status, body: (await res.text()).slice(0, 300) });
        return null;
      }
      const data: any = await res.json();
      return data?.message?.content ?? null;
    } catch (e) {
      log("llm_error", { provider: "ollama", model, error: String(e) });
      return null;
    }
  }
}

export class OpenAIProvider implements LLMProvider {
  async complete(params: { system: string; messages: { role: string; content: string }[] }): Promise<string | null> {
    const key = env.OPENAI_API_KEY || env.OPENAI_REAL_API_KEY || env.BUDDY_OPENAI_API_KEY;
    if (!key) return null;
    const model = env.NATIVE_OPENAI_MODEL ?? "gpt-4.1-nano";
    try {
      const res = await fetch("https://api.openai.com/v1/chat/completions", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${key}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          model,
          messages: [{ role: "system", content: params.system }, ...params.messages],
          max_tokens: 300,
        }),
      });
      if (!res.ok) {
        log("llm_error", { provider: "openai", model, status: res.status, body: (await res.text()).slice(0, 300) });
        return null;
      }
      const data: any = await res.json();
      return data?.choices?.[0]?.message?.content ?? null;
    } catch (e) {
      log("llm_error", { provider: "openai", model, error: String(e) });
      return null;
    }
  }
}

const REPLY_LINES = [
  "interesting — say more?",
  "good point, curious how that holds up in practice.",
  "makes sense to me.",
  "anyone tried the opposite approach?",
  "noted, following this one.",
];

// Scripted stand-in for a real model — same action grammar, same context
// shape (parses the JSON userContent nativeAgents.ts builds), just picks
// from a small pool instead of thinking. Lets the invite/reply/memory
// pipeline run live before an OPENROUTER_API_KEY is wired in; swap out by
// setting that env var, no code change needed (see nativeAgents.ts default).
export class MockLLMProvider implements LLMProvider {
  async complete(params: { system: string; messages: { role: string; content: string }[] }): Promise<string | null> {
    let ctx: any = {};
    try {
      ctx = JSON.parse(params.messages[params.messages.length - 1]?.content ?? "{}");
    } catch {
      return JSON.stringify({ action: "idle" });
    }
    const rooms: any[] = ctx.rooms ?? [];
    const roomsWithNewcomers = rooms.filter((r) => (r.newcomerAgentIds ?? []).length > 0);
    const roomsWithMessages = rooms.filter((r) => (r.recentMessages ?? []).length > 0);

    const roll = Math.random();
    if (roll < 0.15 && roomsWithNewcomers.length) {
      const room = roomsWithNewcomers[Math.floor(Math.random() * roomsWithNewcomers.length)];
      return JSON.stringify({ action: "invite", conversationId: room.conversationId, targetAgentId: room.newcomerAgentIds[0] });
    }
    if (roll < 0.55 && roomsWithMessages.length) {
      const room = roomsWithMessages[Math.floor(Math.random() * roomsWithMessages.length)];
      const last = room.recentMessages[room.recentMessages.length - 1];
      const line = REPLY_LINES[Math.floor(Math.random() * REPLY_LINES.length)];
      return JSON.stringify({ action: "reply", conversationId: room.conversationId, content: line, replyToId: last?.messageId });
    }
    return JSON.stringify({ action: "idle" });
  }
}
