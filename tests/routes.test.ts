import { test } from "node:test";
import assert from "node:assert/strict";
import { POST as adminLogin } from "../src/app/api/admin/login/route";
import { POST as chat } from "../src/app/api/chat/route";
import { POST as summary } from "../src/app/api/summary/route";
import { POST as transcribe } from "../src/app/api/transcribe/route";
import { checkRateLimit } from "../src/lib/rateLimit";
import { readNdjson } from "../src/lib/ndjson";
import type { ChatStreamEvent } from "../src/types";
import { gemini, text, withEnv, withFetch } from "./helpers";

const ip = () => ({ "x-vercel-forwarded-for": `test-${crypto.randomUUID()}` });
const post = (url: string, body: unknown) => new Request(url, { method: "POST", headers: { "Content-Type": "application/json", ...ip() }, body: JSON.stringify(body) });

async function events(response: Response) {
  const out: ChatStreamEvent[] = [];
  for await (const event of readNdjson<ChatStreamEvent>(response.body!)) out.push(event);
  return out;
}

test("admin login cookie is available to the protected admin API", () =>
  withEnv({ ADMIN_TOKEN: "test-admin-token", NODE_ENV: "production" }, async () => {
    const response = await adminLogin(post("http://localhost/api/admin/login", { token: "test-admin-token" }));
    assert.equal(response.status, 200);
    assert.match(response.headers.get("Set-Cookie") ?? "", /(?:^|;\s*)Path=\/;/);
  }));

test("chat streams tool events, the reply and a new signed session", () =>
  withEnv({ GEMINI_API_KEY: undefined, OPENAI_API_KEY: undefined }, async () => {
    const response = await chat(post("http://localhost/api/chat", { messages: [{ role: "user", content: "Where is ORD-101?" }] }));
    assert.equal(response.status, 200);
    assert.match(response.headers.get("Content-Type") ?? "", /ndjson/);
    const stream = await events(response);
    assert.deepEqual(stream.map(e => e.type), ["tool_call", "tool_result", "reply", "done"]);
    const done = stream.at(-1) as Extract<ChatStreamEvent, { type: "done" }>;
    assert.equal(done.mode, "demo");

    // The session carries state into the next turn: a cancellation needs the earlier question.
    const ask = await events(await chat(post("http://localhost/api/chat", { messages: [{ role: "user", content: "Cancel ORD-103" }], session: done.session })));
    const askDone = ask.at(-1) as Extract<ChatStreamEvent, { type: "done" }>;
    const confirm = await events(await chat(post("http://localhost/api/chat", {
      messages: [{ role: "user", content: "Cancel ORD-103" }, { role: "assistant", content: "Shall I go ahead?" }, { role: "user", content: "yes" }],
      session: askDone.session,
    })));
    assert.deepEqual((confirm.at(-1) as Extract<ChatStreamEvent, { type: "done" }>).cancelled, ["ORD-103"]);
  }));

test("chat rejects malformed requests and forged sessions", async () => {
  assert.equal((await chat(post("http://localhost/api/chat", { messages: [] }))).status, 400);
  assert.equal((await chat(post("http://localhost/api/chat", { messages: [{ role: "assistant", content: "hi" }] }))).status, 400);
  assert.equal((await chat(post("http://localhost/api/chat", { messages: [{ role: "user", content: "hi" }], session: "forged.token" }))).status, 400);
});

test("chat reports provider failures as an error event, without a new session", () =>
  withEnv({ GEMINI_API_KEY: "test-key" }, () =>
    withFetch(() => new Response("{}", { status: 500 }), async () => {
      const stream = await events(await chat(post("http://localhost/api/chat", { messages: [{ role: "user", content: "Hello" }] })));
      assert.deepEqual(stream.map(e => e.type), ["error"]);
    })));

test("summary falls back to rules when the model output is unusable", () =>
  withEnv({ GEMINI_API_KEY: "test-key" }, () =>
    withFetch(() => gemini(text("not json")), async () => {
      const response = await summary(post("http://localhost/api/summary", { transcript: [{ role: "user", content: "Hello" }], metrics: { duration_seconds: 10, avg_response_ms: null } }));
      assert.equal(response.status, 200);
      const data = await response.json();
      assert.equal(data.generated_by, "rules");
      assert.equal(data.metrics.duration_seconds, 10);
    })));

test("transcription returns recognised speech and rejects unsuitable uploads", () =>
  withEnv({ GEMINI_API_KEY: "test-key" }, () =>
    withFetch(
      (_url, body) => {
        assert.equal(body.contents[0].parts[0].inlineData.mimeType, "audio/wav");
        return gemini(text("Where is my order ORD-101?"));
      },
      async () => {
        const form = new FormData();
        form.append("audio", new Blob([new Uint8Array(1200)], { type: "audio/wav" }), "q.wav");
        const ok = await transcribe(new Request("http://localhost/api/transcribe", { method: "POST", headers: ip(), body: form }));
        assert.equal(ok.status, 200);
        assert.equal((await ok.json()).text, "Where is my order ORD-101?");
        const bad = new FormData();
        bad.append("audio", new Blob([new Uint8Array(1200)], { type: "text/plain" }), "q.txt");
        assert.equal((await transcribe(new Request("http://localhost/api/transcribe", { method: "POST", headers: ip(), body: bad }))).status, 400);
      },
    )));

test("requests are rate limited per visitor and endpoint", () => {
  const request = new Request("http://localhost/api/chat", { headers: ip() });
  for (let i = 0; i < 120; i++) assert.equal(checkRateLimit(request, "chat"), true);
  assert.equal(checkRateLimit(request, "chat"), false);
  assert.equal(checkRateLimit(request, "tts"), true);
});
