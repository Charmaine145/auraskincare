import { z } from "zod";
import { brandById, type Brand } from "@/data/brand";
import { productsFor, productSearchText } from "@/data/products";
import { normalizeOrderId } from "@/lib/orders/orderIds";
import { categoryFor, ticketCategory } from "@/lib/ticketCategory";
import type { Intent, Order, Resolution, SessionData, ToolName, ToolStatus, TurnOutcome } from "@/types";

/**
 * Aria's tools. The model decides WHEN to call them; this file decides WHAT is allowed.
 * Every policy decision (cancel, return, replacement) is made here in plain code and its
 * wording is spoken verbatim, so the model can never turn a refusal into a promise.
 */

export interface ToolContext {
  session: SessionData;
  /** Order IDs the customer has actually said during this call. */
  mentionedIds: Set<string>;
  /** Intent of the customer's latest message, used to label outcomes. */
  intent: Intent;
  /** Set when this turn asked the customer to confirm a cancellation. */
  confirmationRequested?: string;
}

export interface ToolExecution {
  status: ToolStatus;
  /** Data returned to the model. */
  output: Record<string, unknown>;
  /** Authoritative wording for policy decisions. */
  say?: string;
  /** Short line for the live activity panel. */
  summary: string;
  outcome?: TurnOutcome;
}

export interface ReturnFacts {
  is_opened?: boolean;
  is_unused?: boolean;
  original_packaging?: boolean;
  is_damaged?: boolean;
  photos_available?: boolean;
}

const orderId = z.string().trim().min(1).max(40);
export const toolSchemas = {
  get_order_details: z.object({ order_id: orderId }),
  cancel_order: z.object({ order_id: orderId, customer_confirmed: z.boolean().optional(), reason: z.string().max(300).optional() }),
  check_return_eligibility: z.object({
    order_id: orderId,
    is_opened: z.boolean().optional(),
    is_unused: z.boolean().optional(),
    original_packaging: z.boolean().optional(),
    is_damaged: z.boolean().optional(),
    photos_available: z.boolean().optional(),
  }),
  escalate_to_human: z.object({ reason: z.string().trim().min(1).max(300), order_id: z.string().max(40).optional() }),
  find_products: z.object({
    query: z.string().trim().max(120).optional(),
    concern: z.string().trim().max(80).optional(),
    skin_type: z.string().trim().max(40).optional(),
    max_price: z.number().int().min(0).max(100_000).optional(),
  }),
} satisfies Record<ToolName, z.ZodTypeAny>;

const fact = (description: string) => ({ type: "boolean", description });
const orderIdParam = { type: "string", description: "The order ID exactly as the customer said it, e.g. ORD-101." };

/** JSON-schema tool declarations shared by the Gemini and OpenAI adapters. */
export const toolDefinitions: { name: ToolName; description: string; parameters: Record<string, unknown> }[] = [
  {
    name: "get_order_details",
    description: "Look up an order by ID. Returns status, product, courier, tracking and what the policy allows for it. Call before stating any order facts. Only use an ID the customer said.",
    parameters: { type: "object", properties: { order_id: orderIdParam }, required: ["order_id"], additionalProperties: false },
  },
  {
    name: "cancel_order",
    description: "Cancel an order, or check whether it can be cancelled. The server enforces the policy. The first call never cancels: for an eligible order it asks the customer to confirm. After the customer clearly agrees, call again with customer_confirmed=true.",
    parameters: {
      type: "object",
      properties: {
        order_id: orderIdParam,
        customer_confirmed: fact("true only when the customer has just confirmed the cancellation you asked about."),
        reason: { type: "string", description: "Optional reason the customer gave." },
      },
      required: ["order_id"],
      additionalProperties: false,
    },
  },
  {
    name: "check_return_eligibility",
    description: "Decide whether an order can be returned, refunded or replaced, including damaged or defective items. Pass only facts the customer stated; leave unknown facts out.",
    parameters: {
      type: "object",
      properties: {
        order_id: orderIdParam,
        is_opened: fact("Customer said the product has been opened."),
        is_unused: fact("Customer said the product is unused."),
        original_packaging: fact("Customer said it is still in its original packaging."),
        is_damaged: fact("Customer said the product arrived damaged or defective."),
        photos_available: fact("Customer said they have photos of the damage."),
      },
      required: ["order_id"],
      additionalProperties: false,
    },
  },
  {
    name: "escalate_to_human",
    description: "Log a request for the brand's human care team to follow up. Use when the customer asks for a person, or accepts your offer because the issue can't be solved within policy.",
    parameters: {
      type: "object",
      properties: { reason: { type: "string", description: "One-line reason for the care team." }, order_id: orderIdParam },
      required: ["reason"],
      additionalProperties: false,
    },
  },
  {
    name: "find_products",
    description: "Search this brand's product catalogue by name, skincare or haircare goal, skin type or budget. Use for product, suitability and routine questions. Only recommend returned products; never invent ingredients, prices or stock. Do not diagnose or promise results.",
    parameters: {
      type: "object",
      properties: {
        query: { type: "string", description: "Words the customer used, e.g. 'moisturiser for dry skin'." },
        concern: { type: "string", description: "The goal, e.g. dryness, dullness, oil control, sun protection, hair fall." },
        skin_type: { type: "string", description: "The customer's stated skin or scalp type, e.g. oily, dry, sensitive." },
        max_price: { type: "number", description: "Maximum budget in rupees, if the customer gave one." },
      },
      additionalProperties: false,
    },
  },
];

/** "Green Tea Face Wash + Toner" -> "Green Tea Face Wash and Toner"; drops "(30ml)". */
export const spokenProduct = (product: string) => product.replace(/\s*\+\s*/g, " and ").replace(/\s*\([^)]*\)/g, "");
const rupees = (value: number) => `${value.toLocaleString("en-IN")} rupees`;
const lowerFirst = (text: string) => text.charAt(0).toLowerCase() + text.slice(1);

/** The brand this call is for: its orders and policy numbers. */
const brandOf = (session: SessionData): Brand => brandById(session.brand);

/**
 * Order as seen during this call (a cancellation only exists inside the session). Only the call's
 * brand's orders exist: another brand's order ID is simply not found.
 */
export function findOrder(id: string, session: SessionData): Order | null {
  const normalized = normalizeOrderId(id);
  const order = brandOf(session).orders.find(o => o.order_id === normalized);
  if (!order) return null;
  return session.cancelled.includes(normalized) ? { ...order, status: "Cancelled", notes: "Cancelled during this call" } : { ...order };
}

/** Natural one-line status, used by the rule-based mode and in summaries. */
const ago = (count: number | undefined, unit: "day" | "hour") =>
  count === undefined ? `a few ${unit}s ago` : unit === "day" && count === 1 ? "yesterday" : `${count} ${unit}${count === 1 ? "" : "s"} ago`;

export function describeOrder(order: Order): string {
  const product = spokenProduct(order.product);
  switch (order.status) {
    case "Out for Delivery":
      return `${order.order_id}, your ${product}, is out for delivery with ${order.courier}, tracking number ${order.tracking_id}. It's ${lowerFirst(order.notes)}.`;
    case "Shipped":
      return `${order.order_id}, your ${product}, is on its way with ${order.courier}, tracking number ${order.tracking_id}. ${order.notes}.`;
    case "Delivered":
      return `${order.order_id}, your ${product}, was delivered ${ago(order.delivered_days_ago, "day")} by ${order.courier}.`;
    case "Processing":
      return `${order.order_id}, your ${product}, is still being processed. It was placed ${ago(order.ordered_hours_ago, "hour")} and hasn't shipped yet.`;
    case "Cancelled":
      return `${order.order_id} was cancelled earlier in this call.`;
  }
}

const statusFact = (order: Order) =>
  `${order.status}${order.courier ? ` via ${order.courier} (${order.tracking_id})` : ""}${order.status === "Cancelled" ? "" : `, ${lowerFirst(order.notes)}`}`;

function cancellationNote(order: Order): string {
  if (order.status === "Processing") return "Can be cancelled. Call cancel_order; it will ask the customer to confirm.";
  if (order.status === "Cancelled") return "Already cancelled during this call.";
  if (order.status === "Delivered") return "Already delivered, so it cannot be cancelled.";
  return "Cannot be cancelled any more; the customer may refuse the delivery at the doorstep.";
}

function returnNote(order: Order, brand: Brand): string {
  const window = brand.policy.returnDays;
  if (order.status !== "Delivered" || order.delivered_days_ago === undefined) return "Not delivered yet, so returns do not apply.";
  return order.delivered_days_ago > window
    ? `Outside the ${window}-day return window (delivered ${order.delivered_days_ago} days ago).`
    : `Within the ${window}-day return window, only if unopened, unused and in original packaging.`;
}

function notFound(id: string, intent: Intent): ToolExecution {
  return {
    status: "not_found",
    output: { found: false, order_id: id, instruction: "No such order. Tell the customer you couldn't find it and ask them to check and repeat the ID. Never guess another ID." },
    summary: `No order ${id} in the database`,
    outcome: { intent, order_id: id, resolution: "NEEDS_INFORMATION", detail: `Order ID ${id} was not found; asked the customer to verify it.` },
  };
}

function getOrderDetails(id: string, ctx: ToolContext): ToolExecution {
  const brand = brandOf(ctx.session);
  const order = findOrder(id, ctx.session);
  const intent: Intent = ["CANCELLATION", "RETURN_REQUEST", "DAMAGED_PRODUCT"].includes(ctx.intent) ? ctx.intent : "ORDER_TRACKING";
  if (!order) return notFound(id, intent);
  ctx.session.lastOrder = order.order_id;
  return {
    status: "ok",
    output: {
      found: true,
      order: {
        order_id: order.order_id,
        customer_name: order.customer_name,
        product: order.product,
        value_rupees: order.value,
        status: order.status,
        courier: order.courier ?? null,
        tracking_id: order.tracking_id ?? null,
        notes: order.notes,
      },
      policy: { can_cancel: order.status === "Processing", cancellation: cancellationNote(order), returns: returnNote(order, brand), cash_on_delivery_eligible: order.value <= brand.policy.codLimit },
    },
    summary: `${order.order_id}: ${statusFact(order)}`,
    // Lookups inside a cancel/return question are labelled by the policy tool or the reply instead.
    outcome: intent === "ORDER_TRACKING"
      ? { intent, order_id: order.order_id, resolution: "RESOLVED", detail: `Shared the status of ${order.order_id}: ${statusFact(order)}.` }
      : undefined,
  };
}

function cancelOrder(id: string, confirmed: boolean, ctx: ToolContext): ToolExecution {
  const { session } = ctx;
  const order = findOrder(id, session);
  if (!order) {
    const result = notFound(id, "CANCELLATION");
    return { ...result, say: `I couldn't find an order with the ID ${id}. Could you check the number and read it out again?` };
  }
  session.lastOrder = order.order_id;
  const decided = (status: ToolStatus, say: string, resolution: Resolution, detail: string, summary: string): ToolExecution => ({
    status,
    say,
    summary,
    output: { order_id: order.order_id, status: order.status, result: status, message: say },
    outcome: { intent: "CANCELLATION", order_id: order.order_id, resolution, detail },
  });

  if (order.status === "Cancelled") {
    return decided("done", `${order.order_id} is already cancelled, so there's nothing more to do.`, "RESOLVED", `${order.order_id} had already been cancelled earlier in the call.`, "Already cancelled");
  }
  if (order.status === "Delivered") {
    const window = brandOf(session).policy.returnDays;
    const late = (order.delivered_days_ago ?? 0) > window;
    return decided(
      "declined",
      `${order.order_id} has already been delivered, so it can't be cancelled${late ? `, and it's also past our ${window}-day return window.` : `. If it's unopened, you can return it within ${window} days of delivery.`}`,
      "POLICY_DECLINED",
      `Cancellation of ${order.order_id} declined: already delivered.`,
      "Declined: already delivered",
    );
  }
  if (order.status !== "Processing") {
    return decided(
      "declined",
      `I'm sorry, ${order.order_id} is already ${order.status.toLowerCase()}, so it can no longer be cancelled. If you don't want it, you can simply refuse the delivery at your doorstep.`,
      "POLICY_DECLINED",
      `Cancellation of ${order.order_id} declined: order is ${order.status}; suggested refusing it at the doorstep.`,
      `Declined: ${order.status}`,
    );
  }
  if (!confirmed || session.pendingCancel !== order.order_id) {
    session.pendingCancel = order.order_id;
    ctx.confirmationRequested = order.order_id;
    return decided(
      "confirm",
      `${order.order_id}, your ${spokenProduct(order.product)} for ${rupees(order.value)}, is still being processed, so I can cancel it. Shall I go ahead?`,
      "NEEDS_INFORMATION",
      `Asked the customer to confirm cancelling ${order.order_id}.`,
      "Eligible: waiting for the customer's confirmation",
    );
  }
  session.pendingCancel = undefined;
  session.cancelled.push(order.order_id);
  return decided("done", `Done. I've cancelled ${order.order_id}. Is there anything else I can help you with?`, "RESOLVED", `Cancelled ${order.order_id} after the customer confirmed.`, "Cancelled after confirmation");
}

interface ReturnDecision { status: ToolStatus; say: string; resolution: Resolution; detail: string; summary: string }

function decideReturn(order: Order, facts: ReturnFacts, brand: Brand): ReturnDecision {
  const id = order.order_id;
  const { returnDays, damageHours } = brand.policy;
  if (order.status === "Cancelled") {
    return { status: "declined", say: `${id} was cancelled, so there's nothing to return.`, resolution: "RESOLVED", detail: `No return needed: ${id} was cancelled during the call.`, summary: "Not applicable: cancelled" };
  }
  if (order.status === "Processing") {
    return {
      status: "declined",
      say: `${id} hasn't shipped yet, so there's nothing to return. Since it's still being processed, I can cancel it instead if you'd like.`,
      resolution: "POLICY_DECLINED",
      detail: `Return not possible for ${id}: still Processing; offered cancellation instead.`,
      summary: "Not delivered yet (Processing)",
    };
  }
  if (order.status !== "Delivered" || order.delivered_days_ago === undefined) {
    return {
      status: "declined",
      say: `${id} hasn't been delivered yet. It's ${order.status.toLowerCase()} and ${lowerFirst(order.notes)}. Returns open once it's delivered, and if you don't want it, you can refuse it at the doorstep.`,
      resolution: "POLICY_DECLINED",
      detail: `Return not yet possible for ${id}: ${order.status}; suggested refusing it at the doorstep.`,
      summary: `Not delivered yet (${order.status})`,
    };
  }
  const days = order.delivered_days_ago;
  if (facts.is_damaged) {
    if (days * 24 > damageHours) {
      return {
        status: "declined",
        say: `I'm really sorry about that. Damaged or defective items need to be reported within ${damageHours} hours of delivery, and ${id} was delivered ${days} days ago, so I'm not able to arrange a replacement under our policy.`,
        resolution: "POLICY_DECLINED",
        detail: `Damage claim for ${id} declined: delivered ${days} days ago, outside the ${damageHours}-hour window.`,
        summary: `Declined: damage reported after ${days} days (limit ${damageHours} h)`,
      };
    }
    if (facts.photos_available !== true) {
      return {
        status: "needs_info",
        say: `I'm sorry about that. Since it's within ${damageHours} hours of delivery, it qualifies for a replacement once we have photos. Do you have photos of the damage?`,
        resolution: "NEEDS_INFORMATION",
        detail: `Damage on ${id} reported within ${damageHours} hours; asked for photos.`,
        summary: `Within ${damageHours} h: photos needed`,
      };
    }
    return {
      status: "ok",
      say: "Thank you. This qualifies for a replacement under our damage policy. Please share the photos with our care team so they can arrange it.",
      resolution: "RESOLVED",
      detail: `Damage on ${id} reported within ${damageHours} hours with photos; eligible for a replacement.`,
      summary: "Eligible for replacement",
    };
  }
  if (days > returnDays) {
    return {
      status: "declined",
      say: `I'm sorry, ${id} was delivered ${days} days ago, and returns are only accepted within ${returnDays} days of delivery, so I can't approve a return or refund for it.`,
      resolution: "POLICY_DECLINED",
      detail: `Return for ${id} declined: delivered ${days} days ago, outside the ${returnDays}-day window.`,
      summary: `Declined: delivered ${days} days ago (limit ${returnDays})`,
    };
  }
  if (facts.is_opened === true || facts.is_unused === false || facts.original_packaging === false) {
    return {
      status: "declined",
      say: "I'm sorry, returns are only possible for unopened, unused products in their original packaging, so I can't approve a return for this one.",
      resolution: "POLICY_DECLINED",
      detail: `Return for ${id} declined: opened, used or not in original packaging.`,
      summary: "Declined: opened or used",
    };
  }
  if (facts.is_opened === undefined || facts.is_unused === undefined || facts.original_packaging === undefined) {
    return {
      status: "needs_info",
      say: `${id} is within our ${returnDays}-day return window. Is the ${spokenProduct(order.product)} unopened, unused and still in its original packaging?`,
      resolution: "NEEDS_INFORMATION",
      detail: `Asked whether ${id} is unopened, unused and in its original packaging.`,
      summary: `Within ${returnDays} days: checking condition`,
    };
  }
  return {
    status: "ok",
    say: `Good news, ${id} is eligible for a return, since it was delivered ${days} days ago and is unopened and unused in its original packaging.`,
    resolution: "RESOLVED",
    detail: `Return for ${id} confirmed eligible: within ${returnDays} days, unopened and unused.`,
    summary: "Eligible for return",
  };
}

export function checkReturnEligibility(id: string, facts: ReturnFacts, session: SessionData): ToolExecution {
  const order = findOrder(id, session);
  if (!order) {
    const result = notFound(id, facts.is_damaged ? "DAMAGED_PRODUCT" : "RETURN_REQUEST");
    return { ...result, say: `I couldn't find an order with the ID ${id}. Could you check the number and read it out again?` };
  }
  session.lastOrder = order.order_id;
  const decision = decideReturn(order, facts, brandOf(session));
  return {
    status: decision.status,
    say: decision.say,
    summary: decision.summary,
    output: { order_id: order.order_id, eligible: decision.status === "ok", result: decision.status, message: decision.say },
    outcome: { intent: facts.is_damaged ? "DAMAGED_PRODUCT" : "RETURN_REQUEST", order_id: order.order_id, resolution: decision.resolution, detail: decision.detail },
  };
}

const PRODUCT_ALIASES: Record<string, string[]> = {
  oily: ["oily", "oil control", "shine", "blemish"],
  dry: ["dry", "dryness", "dehydrated", "flaky"],
  sensitive: ["sensitive", "sensitivity", "irritation", "calm"],
  combination: ["combination"],
  normal: ["normal"],
  acne: ["blemish", "acne", "breakout", "oil control"],
  blemish: ["blemish", "acne", "breakout", "oil control"],
  dull: ["dull", "dullness", "bright", "glow", "radiance"],
  brightening: ["bright", "dull", "glow", "radiance", "tone"],
  hydration: ["hydrat", "dry", "moistur"],
  "hair fall": ["hair fall", "breakage", "weak hair", "fuller"],
  dandruff: ["flaky", "itchy scalp", "neem"],
  frizz: ["frizz", "dryness", "breakage"],
};
const aliasFor = (value: string) => {
  const key = value.toLowerCase().trim();
  return PRODUCT_ALIASES[key] ?? [key];
};

function findProducts(args: { query?: string; concern?: string; skin_type?: string; max_price?: number }, ctx: ToolContext): ToolExecution {
  const brand = brandOf(ctx.session);
  const query = args.query?.toLowerCase().trim() ?? "";
  const concern = args.concern?.toLowerCase().trim() ?? "";
  const skin = args.skin_type?.toLowerCase().trim() ?? "";
  if (!query && !concern && !skin && args.max_price === undefined) {
    return {
      status: "needs_info",
      output: { found: false, instruction: "Ask whether they have a goal (for example dryness, dullness or oil control), their skin type, and their budget. Do not guess a product." },
      summary: "Product search needs a goal or skin type",
      outcome: { intent: "PRODUCT_QUESTION", order_id: null, resolution: "NEEDS_INFORMATION", detail: "Asked what the customer wants from a product before recommending one." },
    };
  }

  const words = [...new Set([query, concern, skin].join(" ").split(/[^a-z0-9]+/).filter(word => word.length > 2 && !["for", "the", "and", "with", "product", "products", "skin", "hair", "care"].includes(word)))];
  const concerned = concern ? aliasFor(concern) : [];
  const candidates = productsFor(brand.id).filter(product => {
    if (args.max_price !== undefined && product.price > args.max_price) return false;
    if (skin) {
      const types = product.skin_types.map(type => type.toLowerCase());
      if (types.includes("all")) return true;
      const aliases = aliasFor(skin);
      if (types.some(type => type.includes(skin) || skin.includes(type) || aliases.some(alias => type.includes(alias)))) return true;
      return false;
    }
    return true;
  });

  const scored = candidates
    .map(product => {
      const hay = productSearchText(product);
      let relevance = 0;
      for (const word of words) if (hay.includes(word)) relevance += product.name.toLowerCase().includes(word) ? 4 : 1;
      for (const alias of concerned) if (hay.includes(alias)) relevance += 2;
      // Stock only breaks ties; it must never make an unrelated product a "match".
      const score = relevance + (product.availability === "In stock" ? 1 : 0);
      return { product, score, relevance };
    })
    .filter(item => item.relevance > 0)
    .sort((a, b) => b.score - a.score || Number(b.product.availability === "In stock") - Number(a.product.availability === "In stock"));

  // A goal with no catalogue match is a safe "I don't have that", never an invented product.
  const concernMatched = !concern || scored.some(item => concerned.some(alias => productSearchText(item.product).includes(alias)));
  if (!scored.length || !concernMatched) {
    return {
      status: "needs_info",
      output: {
        found: false,
        instruction: `No product in the ${brand.name} catalogue matches this. Say so plainly, offer a different goal or budget, or offer the care team. Never invent a product, ingredient or price.`,
      },
      summary: "No catalogue match",
      outcome: { intent: "PRODUCT_QUESTION", order_id: null, resolution: "NEEDS_INFORMATION", detail: "No catalogue product matched; offered alternatives or the care team." },
    };
  }

  const matches = scored.slice(0, 3).map(({ product }) => {
    const why: string[] = [];
    if (query && productSearchText(product).includes(query.split(/\s+/)[0])) why.push(`matches “${args.query}”`);
    const hit = product.concerns.find(item => [...words, ...concerned].some(word => item.toLowerCase().includes(word)));
    if (hit) why.push(`aimed at ${hit}`);
    if (skin && (product.skin_types.includes("all") || product.skin_types.some(type => type.toLowerCase().includes(skin) || skin.includes(type.toLowerCase())))) {
      why.push(`suited to ${skin} skin`);
    }
    if (args.max_price !== undefined) why.push(`within ₹${args.max_price.toLocaleString("en-IN")}`);
    return {
      product_id: product.id,
      name: product.name,
      size: product.size,
      price_rupees: product.price,
      availability: product.availability,
      description: product.description,
      usage: product.usage,
      key_ingredients: product.key_ingredients,
      why: why.length ? why.join(", ") : `${product.category} in the ${brand.name} catalogue`,
      note: product.note ?? null,
    };
  });

  return {
    status: "ok",
    output: {
      found: true,
      products: matches,
      note: "Sample catalogue data. Recommend only these products, keep prices and ingredients exactly as given, and make no medical claims. For persistent skin or scalp problems, suggest a qualified professional.",
    },
    summary: `Recommended ${matches.map(item => item.name).join(", ")}`,
    outcome: {
      intent: "PRODUCT_QUESTION",
      order_id: null,
      resolution: "RESOLVED",
      detail: `Suggested ${matches.map(item => item.name).join(", ")} from the catalogue${skin ? ` for ${skin} skin` : ""}.`,
    },
  };
}

function escalate(reason: string, rawOrderId: string | undefined, ctx: ToolContext): ToolExecution {
  const { session } = ctx;
  const candidate = rawOrderId ? normalizeOrderId(rawOrderId) : undefined;
  const order_id = candidate && ctx.mentionedIds.has(candidate) ? candidate : null;
  const existing = session.escalations[0];
  const reference = existing?.reference ?? `${brandOf(session).referencePrefix}-${Math.floor(1000 + Math.random() * 9000)}`;
  if (!existing) {
    session.escalations.push({
      reference,
      reason,
      order_id,
      category: ticketCategory(ctx.intent, reason),
      status: "Open",
      created_at: Date.now(),
    });
  }
  return {
    status: "done",
    output: {
      reference,
      logged: true,
      demo: true,
      note: "Recorded as a demo care-team ticket. Give the customer the reference. Say clearly that this is a demo request and no human has been contacted yet. Do not promise a callback time, refund or outcome.",
    },
    summary: `Care team request ${reference}`,
    outcome: { intent: "HUMAN_HANDOFF", order_id, resolution: "ESCALATED", detail: `Logged demo care-team ticket ${reference}: ${reason}` },
  };
}

/** Runs a tool call from the model or the rule engine, enforcing order-ID provenance. */
export function executeTool(name: string, rawArgs: unknown, ctx: ToolContext): ToolExecution {
  ctx.session.toolCalls++;
  if (!(name in toolSchemas)) return { status: "error", output: { error: `Unknown tool: ${name}` }, summary: "Unknown tool" };
  const tool = name as ToolName;
  const parsed = toolSchemas[tool].safeParse(rawArgs ?? {});
  if (!parsed.success) return { status: "error", output: { error: "Invalid arguments for this tool." }, summary: "Invalid arguments" };
  const args = parsed.data as Record<string, unknown>;

  // Guardrail: the model may only act on order IDs the customer actually said.
  if (tool === "find_products") return findProducts(args as { query?: string; concern?: string; skin_type?: string; max_price?: number }, ctx);
  if (tool !== "escalate_to_human") {
    const id = normalizeOrderId(String(args.order_id));
    if (!ctx.mentionedIds.has(id)) {
      return {
        status: "blocked",
        output: { error: "order_id_not_given_by_customer", instruction: "The customer has not said this order ID in this call. Ask them for their order ID; never guess one." },
        summary: `Blocked ${id}: the customer never said this ID`,
      };
    }
    if (tool === "get_order_details") return getOrderDetails(id, ctx);
    if (tool === "cancel_order") return cancelOrder(id, args.customer_confirmed === true, ctx);
    return checkReturnEligibility(id, args as ReturnFacts, ctx.session);
  }
  return escalate(String(args.reason), args.order_id as string | undefined, ctx);
}
