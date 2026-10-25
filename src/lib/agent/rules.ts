import { brandById, type Brand } from "@/data/brand";
import { extractOrderIds } from "@/lib/orders/orderIds";
import type { Intent } from "@/types";
import { isGoodbye, policyTopic } from "./intents";
import { recordOutcome, runTool, type Emit, type TurnResult } from "./runtime";
import { describeOrder, findOrder, type ReturnFacts, type ToolContext } from "./tools";

/**
 * Rule-based mode, used when no API key is configured. It runs the same tools and
 * guardrails as the AI path, so the demo stays honest, but it only understands
 * the assessment scenarios and short follow-ups.
 */

const ORDER_INTENTS: Intent[] = ["ORDER_TRACKING", "CANCELLATION", "RETURN_REQUEST", "DAMAGED_PRODUCT"];
const WORD_NUMBERS: Record<string, number> = { ten: 10, eleven: 11, twelve: 12, fifteen: 15, twenty: 20, thirty: 30, forty: 40, sixty: 60, ninety: 90 };
const rupees = (value: number) => `${value.toLocaleString("en-IN")} rupees`;

export function parseReturnFacts(text: string, intent: Intent): ReturnFacts {
  const t = text.toLowerCase();
  const sealed = /\b(sealed|still packed|seal (is )?intact)\b/.test(t);
  const facts: ReturnFacts = {};
  if (sealed || /\b(unopened|not opened|haven'?t opened|have not opened|didn'?t open|did not open|never opened)\b/.test(t)) facts.is_opened = false;
  else if (/\b(opened|open kiya|khol\w*)\b/.test(t)) facts.is_opened = true;
  if (sealed || /\b(unused|not used|haven'?t used|didn'?t use|never used)\b/.test(t)) facts.is_unused = true;
  else if (/\b(used|using|tried|applied)\b/.test(t)) facts.is_unused = false;
  if (sealed || /\b(original (packaging|box|pack)|in the box)\b/.test(t)) facts.original_packaging = true;
  else if (/\b(no box|without (the )?(box|packaging)|threw (away|out)|discarded)\b/.test(t)) facts.original_packaging = false;
  if (intent === "DAMAGED_PRODUCT") {
    facts.is_damaged = true;
    if (/\b(photos?|pictures?|pics?|images?)\b/.test(t) && !/\b(no|don'?t have|haven'?t|without)\s+(any\s+)?(photos?|pictures?|pics?)\b/.test(t)) facts.photos_available = true;
  }
  return facts;
}

/** The brief's example: "I bought this 20 days ago and have opened it. Can I return it?" needs no order ID. */
function describedReturnViolation(text: string, brand: Brand): string | null {
  const window = brand.policy.returnDays;
  const t = text.toLowerCase();
  const match = /\b(\d+|[a-z]+)\s*(days?|din)\b/.exec(t);
  const days = match ? (/^\d+$/.test(match[1]) ? Number(match[1]) : WORD_NUMBERS[match[1]]) : undefined;
  const facts = parseReturnFacts(text, "RETURN_REQUEST");
  const opened = facts.is_opened === true || facts.is_unused === false;
  const late = days !== undefined && days > window;
  if (opened && late) return `I'm sorry, returns are only accepted within ${window} days of delivery, for unopened and unused products in their original packaging. Since it's been ${days} days and the product has been opened, it isn't eligible for a return or refund.`;
  if (opened) return "I'm sorry, returns are only accepted for unopened, unused products in their original packaging, so an opened product isn't eligible for a return or refund.";
  if (late) return `I'm sorry, returns are only accepted within ${window} days of delivery, so after ${days} days it isn't eligible for a return or refund.`;
  return null;
}

function policyAnswer(text: string, brand: Brand): string {
  const p = brand.policy;
  const free = p.freeShippingAbove.toLocaleString("en-IN");
  switch (policyTopic(text)) {
    case "cod":
      return `Yes, Cash on Delivery is available for orders up to ${p.codLimit.toLocaleString("en-IN")} rupees, and you can pay by cash or UPI at your doorstep.`;
    case "shipping":
      return new RegExp(`\\b${p.freeShippingAbove}\\b`).test(text)
        ? `Delivery is free above ${free} rupees and there's a ${p.shippingFee} rupee fee below that, but our policy doesn't say what applies at exactly ${free}, so I'd rather not guess.`
        : `Delivery is free on orders above ${free} rupees; below that there's a ${p.shippingFee} rupee shipping fee. Standard delivery takes ${p.deliveryDays[0]} to ${p.deliveryDays[1]} business days.`;
    case "returns":
      return `Returns are accepted within ${p.returnDays} days of delivery for unopened, unused products in their original packaging.`;
    case "damage":
      return `If a product arrives damaged or defective, please report it within ${p.damageHours} hours of delivery with photos, and we'll arrange a replacement.`;
    case "cancellation":
      return "Orders can be cancelled only while they're still processing. Once shipped or out for delivery, you can refuse the parcel at the doorstep instead.";
    case "brand":
      return `${brand.overview} How can I help you today?`;
    default:
      return "I can help with order status, returns, cancellations, delivery charges and Cash on Delivery. What would you like to know?";
  }
}

const say = (reply: string, endCall = false): TurnResult => ({ reply, source: "rules", endCall });

export function rulesReply(text: string, ctx: ToolContext, emit: Emit): TurnResult {
  const { session } = ctx;
  const brand = brandById(session.brand);
  const t = text.toLowerCase().trim();
  const ids = extractOrderIds(text);
  let intent = ctx.intent;

  if (/\b(don'?t|do not|never|not)\s+(want to\s+)?cancel\b/.test(t)) {
    session.pendingIntent = undefined;
    return say("Of course, I won't cancel anything.");
  }
  // A bare ID ("one zero three") answers the question Aria asked in the previous turn.
  const explicitTracking = /\b(where|track\w*|status|when|kab|kahan)\b/.test(t);
  if (session.pendingIntent && ids.length && (intent === "GENERAL" || (intent === "ORDER_TRACKING" && !explicitTracking))) intent = session.pendingIntent;

  if (ORDER_INTENTS.includes(intent)) {
    const refersBack = /\b(it|that|this one|that order|this order|same order)\b/.test(t);
    // A follow-up with no ID is about the last checked order, but only when it is the one
    // order this call has actually mentioned. Never invent or reuse an unverified ID.
    const ambiguous = !ids.length && !session.pendingIntent && ctx.mentionedIds.size > 1 && (refersBack || intent === "ORDER_TRACKING");
    if (ambiguous) {
      const list = [...ctx.mentionedIds].join(", ");
      return say(`Happy to help with that. Which order do you mean: ${list}?`);
    }
    const remembered = session.lastOrder && ctx.mentionedIds.has(session.lastOrder) && ctx.mentionedIds.size === 1 ? session.lastOrder : undefined;
    const id = ids[0] ?? (refersBack || session.pendingIntent ? session.lastOrder : remembered);
    if (!id) {
      const violation = intent === "RETURN_REQUEST" ? describedReturnViolation(text, brand) : null;
      if (violation) return say(violation);
      session.pendingIntent = intent;
      return say("Sure, I can help with that. Could you tell me your order ID? It looks like O R D, then three digits.");
    }
    session.pendingIntent = undefined;
    const notFound = `I couldn't find an order with the ID ${id}. Could you check the number and read it out again?`;

    if (intent === "ORDER_TRACKING") {
      const result = runTool("get_order_details", { order_id: id }, ctx, emit);
      if (result.status === "not_found") {
        session.pendingIntent = "ORDER_TRACKING";
        return say(notFound);
      }
      return say(describeOrder(findOrder(id, session)!));
    }
    const result = intent === "CANCELLATION"
      ? runTool("cancel_order", { order_id: id }, ctx, emit)
      : runTool("check_return_eligibility", { order_id: id, ...parseReturnFacts(text, intent) }, ctx, emit);
    if (result.status === "not_found") session.pendingIntent = intent;
    return say(result.say ?? notFound);
  }

  if (intent === "PRODUCT_QUESTION") {
    const budget = /(?:under|below|upto|up to|budget(?: of)?|₹|rs\.?)\s*₹?\s*(\d{2,5})/.exec(t);
    const skin = /\b(oily|dry|sensitive|combination|normal)\b/.exec(t)?.[1];
    const concern = /\b(dryness|dullness|dull|oil control|acne|blemish\w*|sensitivity|hydration|sun protection|hair fall|dandruff|frizz|brightening)\b/.exec(t)?.[1];
    const result = runTool("find_products", {
      query: text,
      ...(skin ? { skin_type: skin } : {}),
      ...(concern ? { concern } : {}),
      ...(budget ? { max_price: Number(budget[1]) } : {}),
    }, ctx, emit);
    if (result.status !== "ok") {
      return say(result.summary === "No catalogue match"
        ? `I don't have a product in the ${brand.name} catalogue that matches that. I can check a different goal or budget, or our care team can help.`
        : "Happy to help with products. What's the main goal, such as dryness, dullness or oil control, and do you have a budget in mind?");
    }
    const products = (result.output.products as { name: string; price_rupees: number; why: string; availability: string }[]) ?? [];
    const [first, second] = products;
    if (!first) return say("I couldn't find a matching product in the catalogue. Our care team can help you choose.");
    const stock = first.availability === "In stock" ? "" : " It's currently out of stock.";
    const also = second ? ` You could also consider the ${second.name} at ${rupees(second.price_rupees)}.` : "";
    return say(`I'd suggest the ${first.name} at ${rupees(first.price_rupees)}. It's ${first.why}.${stock}${also} Would you like the usage details?`);
  }

  if (intent === "HUMAN_HANDOFF") {
    // Keep the caller's own words so the ticket is categorised correctly (damage, return, payment…).
    const detail = text.length > 220 ? `${text.slice(0, 217)}…` : text;
    const result = runTool("escalate_to_human", { reason: `Customer asked for a person: ${detail}`, ...(ids[0] ? { order_id: ids[0] } : {}) }, ctx, emit);
    return say(`Of course. I've recorded a demo care-team ticket for you, reference ${String(result.output.reference)}. No human has been contacted yet, and I can't promise a callback time.`);
  }
  if (intent === "POLICY_QUESTION") return say(policyAnswer(text, brand));
  if (intent === "OUT_OF_SCOPE") return say(`I'm sorry, I can only help with ${brand.name} orders, products and policies. Is there anything about your ${brand.shortName} order I can help with?`);
  if (isGoodbye(text)) return say(`Thank you for calling ${brand.name}. Have a lovely day!`, true);
  if (/^(thanks|thank you|thank u|thx|dhanyavaad|dhanyavad|shukriya)\b/.test(t)) return say("You're very welcome! Is there anything else I can help you with?");
  if (/^(hi|hello|hey|namaste|good (morning|afternoon|evening))\b/.test(t)) return say(`Hello! I can help with your ${brand.shortName} orders, returns, cancellations, delivery, Cash on Delivery or product questions. What would you like to know?`);

  recordOutcome(session, { intent: "GENERAL", order_id: null, resolution: "NEEDS_INFORMATION", detail: "Asked the customer to repeat an unclear request." });
  return say("I'm sorry, I didn't quite catch that. Could you say it again, or tell me your order ID?");
}
