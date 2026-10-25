import type { ChatMessage, Intent, SessionData, TurnOutcome } from "@/types";
import { brandById, type Brand } from "@/data/brand";
import { languageByCode, replyLanguage } from "@/lib/voice/languages";
import { extractOrderIds, normalizeOrderId } from "@/lib/orders/orderIds";
import { detectIntent, isAffirmative, isGoodbye, isNegative, policyTopic } from "./intents";
import { callStateNote, languageNote, systemPrompt } from "./prompt";
import { getProvider, type AgentMessage, type ChatProvider } from "./providers";
import { rulesReply } from "./rules";
import { recordOutcome, runTool, type Emit, type TurnResult } from "./runtime";
import { describeOrder, findOrder, type ToolContext } from "./tools";

/**
 * One customer turn:
 *   1. deterministic fast path (answering a pending "shall I cancel?" question),
 *   2. otherwise the model loop (or rule engine) with server-enforced tools,
 *   3. a verified outcome is recorded for the post-call summary.
 */

const MAX_ROUNDS = 4;

export async function runTurn(history: ChatMessage[], session: SessionData, emit: Emit, signal?: AbortSignal, language?: string): Promise<TurnResult> {
  const text = history.at(-1)!.content;
  const mentioned = [...new Set(history.filter(m => m.role === "user").flatMap(m => extractOrderIds(m.content)))];
  const ctx: ToolContext = { session, mentionedIds: new Set(mentioned), intent: detectIntent(text) };
  // Conversation memory: a short "when will it arrive?" follows the one order this call has
  // verified. With several orders in play the intent stays GENERAL and Aria asks which one.
  if (ctx.intent === "GENERAL" && isSingleOrderFollowUp(text, ctx)) ctx.intent = "ORDER_TRACKING";
  // Several orders in play: a bare "when will it arrive?" must ask which one, never guess.
  else if (ctx.intent === "GENERAL" && ctx.mentionedIds.size > 1 && TRACKING_WORDS.test(text.toLowerCase())) ctx.intent = "ORDER_TRACKING";
  const pendingBefore = session.pendingCancel;
  const outcomesBefore = session.outcomes.length;
  const reply = replyLanguage(history.filter(m => m.role === "user").map(m => m.content), language);

  const provider = getProvider();
  let result = answerPendingCancellation(text, ctx, emit) ?? (provider ? directTracking(text, ctx, emit) : null);
  if (!result) result = provider ? await modelTurn(provider, history, ctx, mentioned, reply, emit, signal) : rulesReply(text, ctx, emit);

  // A confirmation question lapses once the customer talks about something else.
  if (pendingBefore && session.pendingCancel === pendingBefore && ctx.confirmationRequested !== pendingBefore) session.pendingCancel = undefined;
  if (session.outcomes.length === outcomesBefore) {
    const inferred = inferOutcome(text, ctx.intent, result.reply, brandById(session.brand));
    if (inferred) recordOutcome(session, inferred);
  }
  if (reply !== "en-IN" && (result.source === "policy" || result.source === "direct")) result = await localize(result, reply, emit, signal);
  return { ...result, endCall: result.endCall || (isGoodbye(text) && !/\?\s*$/.test(result.reply)) };
}

/** Numbers and IDs that must survive translation untouched. */
const facts = (text: string) => text.match(/ORD-\d+|[A-Z]{2}-\d+|\d[\d,.]*/g) ?? [];

/**
 * Policy decisions are worded by the server in English. For a caller speaking another Indian
 * language they are translated faithfully, and the translation is used only if every order ID
 * and number survived; otherwise the English original is spoken.
 */
async function localize(result: TurnResult, code: string, emit: Emit, signal?: AbortSignal): Promise<TurnResult> {
  const provider = getProvider();
  if (!provider) return result;
  const language = languageByCode(code).label;
  try {
    const { text } = await provider.json<{ text: string }>({
      system: `You translate customer-care replies for a voice call. Translate into ${language}, written in its native script. Keep the meaning exactly: never add, remove, soften or promise anything. The speaker is a woman, so use feminine forms for herself (Hindi: "सकती हूँ"). Keep order IDs, tracking numbers and numerals unchanged. Parts already in ${language} stay as they are. Return only JSON.`,
      prompt: result.reply,
      schema: { type: "object", properties: { text: { type: "string" } }, required: ["text"], additionalProperties: false },
      signal,
    });
    const translated = text?.trim();
    if (!translated || !facts(result.reply).every(fact => translated.includes(fact))) throw new Error("translation lost a fact");
    emit({ type: "guardrail", rule: "Faithful translation", detail: `Policy decision translated to ${language}; IDs and numbers verified` });
    return { ...result, reply: translated };
  } catch {
    emit({ type: "guardrail", rule: "Faithful translation", detail: `Kept the English wording (translation unavailable or unverified)` });
    return result;
  }
}

const TRACKING_WORDS = /\b(where|track\w*|status|when|arriv\w*|reach\w*|deliver\w*|kab|kahan|kaha|aayega|ayega|aaega|pahunch\w*)\b/;
// Anything that turns a status question into a complaint, a request or a second question needs the model.
const NEEDS_JUDGEMENT = /n't\b|\b(not|never|no|wrong|late|delay\w*|still|yet|why|missing|lost|stolen|cod|cash|upi|pay\w*|address|change|cancel\w*|return\w*|refund\w*|replace\w*|damag\w*|broken|but|also|problem|issue|complain\w*|nahi|nahin)\b/;

/**
 * "Where is ORD-101?" is the most common call and needs no judgement: one lookup, then the facts.
 * It is answered from the verified record with no model call (two model rounds take 2 to 5 s).
 * Only short, single-ID status questions qualify; anything else goes to the model as usual.
 */
function directTracking(text: string, ctx: ToolContext, emit: Emit): TurnResult | null {
  const t = text.toLowerCase();
  const ids = extractOrderIds(text);
  if (ctx.intent !== "ORDER_TRACKING" || ids.length > 1 || ctx.session.pendingCancel) return null;
  if (!TRACKING_WORDS.test(t) || NEEDS_JUDGEMENT.test(t) || t.split(/\s+/).length > 12) return null;
  const id = ids[0] ?? (isSingleOrderFollowUp(text, ctx) ? ctx.session.lastOrder : undefined);
  if (!id) return null;
  const result = runTool("get_order_details", { order_id: id }, ctx, emit);
  if (result.status === "not_found") {
    return { reply: `I couldn't find an order with the ID ${id}. Could you check the number and read it out again?`, source: "direct", endCall: false };
  }
  const order = result.status === "ok" ? findOrder(id, ctx.session) : null;
  return order ? { reply: describeOrder(order), source: "direct", endCall: false } : null;
}

/** True only when exactly one order has been verified in this call and it is the last one discussed. */
function isSingleOrderFollowUp(text: string, ctx: ToolContext): boolean {
  const last = ctx.session.lastOrder;
  if (!last || !ctx.mentionedIds.has(last) || ctx.mentionedIds.size !== 1) return false;
  return TRACKING_WORDS.test(text.toLowerCase());
}

/** "Yes" / "No" after "Shall I go ahead?" is handled in code: instant, and never left to the model. */
function answerPendingCancellation(text: string, ctx: ToolContext, emit: Emit): TurnResult | null {
  const pending = ctx.session.pendingCancel;
  if (!pending || extractOrderIds(text).some(id => id !== pending)) return null;
  if (isAffirmative(text)) {
    emit({ type: "guardrail", rule: "Confirmation before action", detail: `Customer confirmed cancelling ${pending}` });
    const result = runTool("cancel_order", { order_id: pending, customer_confirmed: true }, ctx, emit);
    return { reply: result.say ?? "Done.", source: "policy", endCall: false };
  }
  if (isNegative(text)) {
    ctx.session.pendingCancel = undefined;
    emit({ type: "guardrail", rule: "Confirmation before action", detail: `Customer declined; ${pending} left unchanged` });
    recordOutcome(ctx.session, { intent: "CANCELLATION", order_id: pending, resolution: "RESOLVED", detail: `Customer chose to keep ${pending}; nothing was cancelled.` });
    return { reply: `No problem, I'll leave ${pending} as it is. Is there anything else I can help you with?`, source: "policy", endCall: false };
  }
  return null;
}

/** Merges consecutive same-role messages (e.g. after a failed turn) into the provider format. */
function toAgentMessages(history: ChatMessage[]): AgentMessage[] {
  const merged: ChatMessage[] = [];
  for (const message of history) {
    const last = merged.at(-1);
    if (last && last.role === message.role) last.content = `${last.content}\n${message.content}`;
    else merged.push({ ...message });
  }
  return merged.map(m => (m.role === "user" ? { role: "user", text: m.content } : { role: "assistant", text: m.content, toolCalls: [] }));
}

async function modelTurn(provider: ChatProvider, history: ChatMessage[], ctx: ToolContext, mentioned: string[], reply: string, emit: Emit, signal?: AbortSignal): Promise<TurnResult> {
  const messages = toAgentMessages(history);
  const system = [systemPrompt(brandById(ctx.session.brand)), callStateNote(ctx.session, mentioned), languageNote(reply)];
  // Policy decisions, spoken word for word before anything the model adds.
  const decisions: string[] = [];

  for (let round = 1; round <= MAX_ROUNDS; round++) {
    const started = performance.now();
    const response = await provider.chat({ system, messages, signal });
    emit({ type: "model", model: response.model, round, ms: Math.round(performance.now() - started) });

    if (!response.toolCalls.length) {
      if (decisions.length) return { reply: [...decisions, response.text].filter(Boolean).join(" "), source: "policy", endCall: false };
      return { reply: response.text || "I'm sorry, I didn't quite catch that. Could you say it again?", source: "model", endCall: false };
    }

    messages.push({ role: "assistant", text: response.text, toolCalls: response.toolCalls, raw: response.raw });
    const results = [];
    const decided = new Set<string>();
    const openCalls: { name: string; orderId?: string }[] = [];
    for (const call of response.toolCalls) {
      const result = runTool(call.name, call.args, ctx, emit);
      results.push({ call, output: result.output });
      const orderId = typeof call.args.order_id === "string" ? normalizeOrderId(call.args.order_id) : undefined;
      if (result.say) {
        decisions.push(result.say);
        if (orderId) decided.add(orderId);
      } else openCalls.push({ name: call.name, orderId });
    }
    messages.push({ role: "tool", results });
    // A lookup of an order that also got a policy decision adds nothing; only other open calls need the model.
    const modelMustContinue = openCalls.some(open => !(open.name === "get_order_details" && open.orderId && decided.has(open.orderId)));

    // Cancel/return decisions need no second model call: they are final and already worded.
    if (decisions.length && !modelMustContinue) return { reply: decisions.join(" "), source: "policy", endCall: false };
    if (decisions.length) {
      system.push(`The customer will first hear this, word for word: "${decisions.join(" ")}" Answer only what is still open, in one short sentence, without repeating it.`);
    }
  }
  if (decisions.length) return { reply: decisions.join(" "), source: "policy", endCall: false };
  return { reply: "Could you tell me the order ID you'd like me to check?", source: "model", endCall: false };
}

const DECLINE = /\b(can't|cannot|can not|not able|unable|isn't eligible|not eligible|won't be able|outside (our|the)|only (help|assist) with)\b/i;
const TOPIC_LABEL = { cod: "Cash on Delivery", shipping: "shipping and delivery", returns: "the return policy", damage: "damaged products", cancellation: "cancellations", brand: "the brand", general: "the brand's policies" };

/** Labels a turn that used no tool, from the customer's intent and Aria's reply. */
function inferOutcome(text: string, intent: Intent, reply: string, brand: Brand): TurnOutcome | null {
  if (isGoodbye(text) || /^(ok(ay)?\s*)?(thanks|thank you|thank u|thx|dhanyavaa?d|shukriya)\b/i.test(text.trim())) return null;
  const asked = /\?\s*$/.test(reply);
  const asksForId = /\?/.test(reply) && /\b(order id|order number|ID)\b/i.test(reply);
  const orderId = extractOrderIds(text)[0] ?? null;
  switch (intent) {
    case "OUT_OF_SCOPE":
      return { intent, order_id: null, resolution: "POLICY_DECLINED", detail: `Declined an out-of-scope request and steered back to ${brand.shortName} support.` };
    case "POLICY_QUESTION":
      return { intent, order_id: null, resolution: "RESOLVED", detail: `Answered a question about ${TOPIC_LABEL[policyTopic(text)]}.` };
    case "PRODUCT_QUESTION":
      return { intent, order_id: null, resolution: "RESOLVED", detail: "Answered a product question from the verified catalogue." };
    case "HUMAN_HANDOFF":
      return { intent, order_id: null, resolution: "NEEDS_INFORMATION", detail: "Offered to connect the customer with the care team." };
    case "GENERAL":
      return /\b(repeat|say (that|it) again|didn't (quite )?catch|couldn't (quite )?(hear|understand))\b/i.test(reply)
        ? { intent, order_id: null, resolution: "NEEDS_INFORMATION", detail: "Asked the customer to repeat an unclear request." }
        : null;
    default:
      if (asksForId) return { intent, order_id: orderId, resolution: "NEEDS_INFORMATION", detail: "Asked the customer for their order ID." };
      if (DECLINE.test(reply)) {
        const detail = intent === "RETURN_REQUEST" ? "Explained that the described return falls outside the return policy."
          : intent === "DAMAGED_PRODUCT" ? `Explained the ${brand.policy.damageHours}-hour damage reporting policy.`
          : intent === "CANCELLATION" ? "Explained that the order can't be cancelled under the policy."
          : "Explained what the policy allows for the order.";
        return { intent, order_id: orderId, resolution: "POLICY_DECLINED", detail };
      }
      if (asked) return { intent, order_id: orderId, resolution: "NEEDS_INFORMATION", detail: "Asked the customer for more details." };
      return { intent, order_id: orderId, resolution: "RESOLVED", detail: "Answered the customer's question about their order." };
  }
}
