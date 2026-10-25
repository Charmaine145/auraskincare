import { test } from "node:test";
import assert from "node:assert/strict";
import { runTurn } from "../src/lib/agent/agent";
import { callStateNote } from "../src/lib/agent/prompt";
import { newSession } from "../src/lib/session";
import type { ChatMessage, SessionData } from "../src/types";
import { call, collector, gemini, history, text, withEnv, withFetch } from "./helpers";

const NO_KEYS = { GEMINI_API_KEY: undefined, OPENAI_API_KEY: undefined };
const GEMINI = { GEMINI_API_KEY: "test-key", OPENAI_API_KEY: undefined, GEMINI_MODEL: "gemini-3.5-flash-lite" };

/** Plays a whole conversation through the rule-based engine, returning Aria's replies. */
async function converse(session: SessionData, ...customerLines: string[]) {
  const messages: ChatMessage[] = [];
  const replies: string[] = [];
  let endCall = false;
  for (const line of customerLines) {
    messages.push({ role: "user", content: line });
    const result = await runTurn(messages, session, () => {});
    messages.push({ role: "assistant", content: result.reply });
    replies.push(result.reply);
    endCall = result.endCall;
  }
  return { replies, endCall };
}

test("rules: the assessment scenarios", () =>
  withEnv(NO_KEYS, async () => {
    const session = newSession();
    const { replies } = await converse(
      session,
      "Where is my order O R D one zero one?",
      "Can I return ORD-102?",
      "Where is ORD-999?",
      "Can you book me a flight to Goa?",
      "Is Cash on Delivery available?",
    );
    assert.match(replies[0], /BlueDart.*BD-982103.*6 PM/);
    assert.match(replies[1], /14 days ago.*7 days/);
    assert.match(replies[2], /couldn't find an order with the ID ORD-999/);
    assert.match(replies[3], /only help with Aura Skincare/);
    assert.match(replies[4], /2,500 rupees.*UPI/);
  }));

test("rules: the brief's policy example needs no order ID", () =>
  withEnv(NO_KEYS, async () => {
    const session = newSession();
    const { replies } = await converse(session, "I bought this 20 days ago and have opened it. Can I return it?");
    assert.match(replies[0], /isn't eligible for a return or refund/);
    assert.equal(session.outcomes.at(-1)?.resolution, "POLICY_DECLINED");
    assert.deepEqual(session.cancelled, []);
  }));

test("cancellation asks for the ID, then confirmation, then acts", () =>
  withEnv(NO_KEYS, async () => {
    const session = newSession();
    const { replies } = await converse(session, "I want to cancel my order", "one zero three", "yes please");
    assert.match(replies[0], /order ID/);
    assert.match(replies[1], /Shall I go ahead\?/);
    assert.deepEqual(session.cancelled, ["ORD-103"]);
    assert.match(replies[2], /I've cancelled ORD-103/);
  }));

test("saying no, or changing the subject, never cancels", () =>
  withEnv(NO_KEYS, async () => {
    const declined = newSession();
    const first = await converse(declined, "Cancel ORD-103", "No, keep it");
    assert.match(first.replies[1], /leave ORD-103 as it is/);
    assert.deepEqual(declined.cancelled, []);

    const movedOn = newSession();
    await converse(movedOn, "Cancel ORD-103", "Actually, where is ORD-101?", "yes");
    assert.deepEqual(movedOn.cancelled, [], "a later 'yes' must not confirm a lapsed question");
    assert.equal(movedOn.pendingCancel, undefined);
  }));

test("goodbye ends the call after Aria's reply", () =>
  withEnv(NO_KEYS, async () => {
    const { endCall } = await converse(newSession(), "Where is ORD-101?", "That's all, thank you, bye");
    assert.equal(endCall, true);
  }));

test("gemini: looks up an order with a tool, then answers in its own words", () =>
  withEnv(GEMINI, () =>
    withFetch(
      (_url, _body, index) => (index === 0 ? gemini(call("get_order_details", { order_id: "ORD-101" }, "fc-1")) : gemini(text("It's out for delivery with BlueDart and should arrive by 6 PM today."))),
      async calls => {
        const session = newSession();
        const { events, emit } = collector();
        // "Still not here" needs judgement, so this goes to the model rather than the instant status answer.
        const result = await runTurn(history("My order ORD one oh one is still not here, where is it?"), session, emit);
        assert.equal(result.reply, "It's out for delivery with BlueDart and should arrive by 6 PM today.");
        assert.equal(result.source, "model");
        assert.deepEqual(events.map(e => e.type), ["model", "tool_call", "tool_result", "model"]);
        // The second request replays the model's parts (thought signature) and answers with the matching call ID.
        const contents = calls[1].body.contents;
        assert.equal(contents.at(-2).parts[0].thoughtSignature, "sig-123");
        assert.equal(contents.at(-1).parts[0].functionResponse.id, "fc-1");
        assert.equal(contents.at(-1).parts[0].functionResponse.response.order.status, "Out for Delivery");
        assert.equal(session.outcomes.at(-1)?.resolution, "RESOLVED");
      },
    )));

test("gemini: several orders in one question are all looked up", () =>
  withEnv(GEMINI, () =>
    withFetch(
      (_url, _body, index) => (index === 0 ? gemini(call("get_order_details", { order_id: "ORD-101" }), call("get_order_details", { order_id: "ORD-102" })) : gemini(text("Both found."))),
      async calls => {
        const session = newSession();
        const result = await runTurn(history("What's the status of ORD-101 and ORD-102?"), session, () => {});
        assert.equal(result.reply, "Both found.");
        const responses = calls[1].body.contents.at(-1).parts;
        assert.equal(responses.length, 2, "both function responses go back in one turn");
        assert.deepEqual(session.outcomes.map(o => o.order_id), ["ORD-101", "ORD-102"]);
      },
    )));

test("gemini: an invented order ID is blocked and the model must ask", () =>
  withEnv(GEMINI, () =>
    withFetch(
      (_url, _body, index) => (index === 0 ? gemini(call("get_order_details", { order_id: "ORD-101" })) : gemini(text("Could you tell me your order ID?"))),
      async calls => {
        const { events, emit } = collector();
        const result = await runTurn(history("Where is my serum order?"), newSession(), emit);
        assert.equal(result.reply, "Could you tell me your order ID?");
        assert.ok(events.some(e => e.type === "guardrail" && e.rule === "Order-ID provenance"));
        assert.equal(calls[1].body.contents.at(-1).parts[0].functionResponse.response.error, "order_id_not_given_by_customer");
      },
    )));

test("gemini: a return refusal is spoken verbatim without a second model call", () =>
  withEnv(GEMINI, () =>
    withFetch(
      () => gemini(call("check_return_eligibility", { order_id: "ORD-102", is_opened: false })),
      async calls => {
        const result = await runTurn(history("Can I return ORD-102? It's unopened."), newSession(), () => {});
        assert.match(result.reply, /delivered 14 days ago.*can't approve a return or refund/);
        assert.equal(result.source, "policy");
        assert.equal(calls.length, 1);
      },
    )));

test("gemini: cancellation confirmation is handled in code, instantly", () =>
  withEnv(GEMINI, () =>
    withFetch(
      () => gemini(call("cancel_order", { order_id: "ORD-103" })),
      async calls => {
        const session = newSession();
        const ask = await runTurn(history("Please cancel ORD-103"), session, () => {});
        assert.match(ask.reply, /Shall I go ahead\?/);
        assert.deepEqual(session.cancelled, []);
        const confirm = await runTurn(history("Please cancel ORD-103", ask.reply, "Yes, go ahead"), session, () => {});
        assert.match(confirm.reply, /I've cancelled ORD-103/);
        assert.deepEqual(session.cancelled, ["ORD-103"]);
        assert.equal(calls.length, 1, "the yes is resolved without calling the model");
      },
    )));

test("gemini: a policy decision plus a lookup keeps the decision first and verbatim", () =>
  withEnv(GEMINI, () =>
    withFetch(
      (_url, _body, index) => (index === 0 ? gemini(call("cancel_order", { order_id: "ORD-101" }), call("get_order_details", { order_id: "ORD-102" })) : gemini(text("ORD-102 was delivered 14 days ago."))),
      async calls => {
        const result = await runTurn(history("Cancel ORD-101, and where is ORD-102?"), newSession(), () => {});
        assert.match(result.reply, /^I'm sorry, ORD-101 is already out for delivery.*ORD-102 was delivered 14 days ago\.$/);
        assert.match(calls[1].body.systemInstruction.parts[0].text, /word for word/);
      },
    )));

test("gemini: a lookup alongside a decision on the same order doesn't make Aria repeat herself", () =>
  withEnv(GEMINI, () =>
    withFetch(
      () => gemini(call("get_order_details", { order_id: "ORD-102" }), call("check_return_eligibility", { order_id: "ORD-102" })),
      async calls => {
        const result = await runTurn(history("Can I return ORD-102?"), newSession(), () => {});
        assert.equal((result.reply.match(/14 days/g) ?? []).length, 1, "the refusal is spoken once");
        assert.equal(calls.length, 1, "no second model round is needed");
      },
    )));

test("gemini: a policy decision is translated for a Hindi caller, with IDs verified", () =>
  withEnv(GEMINI, () =>
    withFetch(
      (_url, _body, index) => (index === 0
        ? gemini(call("check_return_eligibility", { order_id: "ORD-102" }))
        : gemini(text(JSON.stringify({ text: "माफ़ कीजिए, ORD-102 को 14 दिन पहले डिलीवर किया गया था, और रिटर्न केवल 7 दिनों के भीतर स्वीकार किए जाते हैं, इसलिए मैं इसे मंज़ूर नहीं कर सकती।" })))),
      async calls => {
        const { events, emit } = collector();
        const result = await runTurn(history("ORD-102 वापस करना है"), newSession(), emit);
        assert.match(result.reply, /^माफ़ कीजिए, ORD-102/);
        assert.match(String(calls[1].body.systemInstruction.parts[0].text), /Hindi/);
        assert.equal(calls[1].body.contents[0].parts[0].text.startsWith("I'm sorry, ORD-102 was delivered 14 days ago"), true, "the server's wording is what gets translated");
        assert.ok(events.some(e => e.type === "guardrail" && e.rule === "Faithful translation" && /verified/.test(e.detail)));
      },
    )));

test("gemini: a translation that drops the order ID or a number is rejected in favour of the English original", () =>
  withEnv(GEMINI, () =>
    withFetch(
      (_url, _body, index) => (index === 0
        ? gemini(call("check_return_eligibility", { order_id: "ORD-102" }))
        : gemini(text(JSON.stringify({ text: "माफ़ कीजिए, यह ऑर्डर बहुत पहले डिलीवर हुआ था, इसलिए रिटर्न नहीं हो सकता।" })))),
      async () => {
        const result = await runTurn(history("ORD-102 वापस करना है"), newSession(), () => {});
        assert.match(result.reply, /^I'm sorry, ORD-102 was delivered 14 days ago/);
      },
    )));

test("gemini: English callers and the English setting are never translated", () =>
  withEnv(GEMINI, () =>
    withFetch(
      () => gemini(call("check_return_eligibility", { order_id: "ORD-102" })),
      async calls => {
        await runTurn(history("Can I return ORD-102?"), newSession(), () => {}, undefined, "en-IN");
        assert.equal(calls.length, 1);
      },
    )));

test("gemini: an out-of-scope answer is recorded as a policy decline", () =>
  withEnv(GEMINI, () =>
    withFetch(
      () => gemini(text("I'm sorry, I can only help with Aura Skincare orders and policies.")),
      async () => {
        const session = newSession();
        await runTurn(history("Can you book me a flight to Goa?"), session, () => {});
        assert.equal(session.outcomes.at(-1)?.intent, "OUT_OF_SCOPE");
        assert.equal(session.outcomes.at(-1)?.resolution, "POLICY_DECLINED");
      },
    )));

test("gemini: provider errors surface as friendly messages", () =>
  withEnv({ ...GEMINI, GEMINI_FALLBACK_MODEL: "gemini-3.1-flash-lite" }, () =>
    withFetch(
      () => new Response("{}", { status: 429 }),
      async calls => {
        await assert.rejects(runTurn(history("Hello"), newSession(), () => {}), /usage limit/);
        assert.equal(calls.length, 2, "a quota error is retried once on the fallback model");
      },
    )));

test("a plain status question is answered from the order record with no model call", () =>
  withEnv(GEMINI, () =>
    withFetch(
      () => { throw new Error("the model must not be called"); },
      async calls => {
        const session = newSession();
        const { events, emit } = collector();
        const result = await runTurn(history("Where is my order ORD one oh one?"), session, emit);
        assert.equal(result.source, "direct");
        assert.match(result.reply, /ORD-101, your Vitamin C Serum, is out for delivery with BlueDart, tracking number BD-982103/);
        assert.deepEqual(events.map(e => e.type), ["tool_call", "tool_result"]);
        assert.equal(calls.length, 0);
        assert.equal(session.outcomes.at(-1)?.resolution, "RESOLVED");

        const missing = await runTurn(history("Where is ORD-999?"), newSession(), () => {});
        assert.match(missing.reply, /couldn't find an order with the ID ORD-999/);
        const shipped = await runTurn(history("Status of ORD-106"), newSession(), () => {});
        assert.match(shipped.reply, /was delivered yesterday by Ekart/, "no '1 days ago'");
      },
    )));

test("anything beyond a plain status question still goes to the model", () =>
  withEnv(GEMINI, () =>
    withFetch(
      () => gemini(text("Let me look into that.")),
      async calls => {
        for (const line of ["Where is ORD-101? It's late.", "Why hasn't ORD-104 arrived yet?", "Where is ORD-101 and can I pay cash?", "Where are ORD-101 and ORD-102?", "Where is my order?"]) {
          const before = calls.length;
          const result = await runTurn(history(line), newSession(), () => {});
          assert.notEqual(result.source, "direct", line);
          assert.ok(calls.length > before, `${line} reached the model`);
        }
      },
    )));

test("with several orders in play, Aria is told to ask which one \"it\" means", () => {
  assert.match(callStateNote(newSession(), ["ORD-101", "ORD-103"]), /ask which one \(name the IDs\)/);
  assert.doesNotMatch(callStateNote(newSession(), ["ORD-101"]), /ask which one/);
});
