import { test } from "node:test";
import assert from "node:assert/strict";
import { orders } from "../src/data/orders";
import { checkReturnEligibility, executeTool, findOrder, type ToolContext } from "../src/lib/agent/tools";
import { newSession } from "../src/lib/session";
import type { SessionData } from "../src/types";

const ctx = (session: SessionData = newSession(), ids = ["ORD-101", "ORD-102", "ORD-103", "ORD-999"]): ToolContext => ({
  session,
  mentionedIds: new Set(ids),
  intent: "ORDER_TRACKING",
});

test("order lookup returns live details and what the policy allows", () => {
  const result = executeTool("get_order_details", { order_id: "ORD-101" }, ctx());
  assert.equal(result.status, "ok");
  const output = result.output as { order: { status: string; tracking_id: string }; policy: { can_cancel: boolean } };
  assert.equal(output.order.status, "Out for Delivery");
  assert.equal(output.order.tracking_id, "BD-982103");
  assert.equal(output.policy.can_cancel, false);
  assert.equal(result.outcome?.resolution, "RESOLVED");
});

test("unknown orders are reported, never invented", () => {
  const result = executeTool("get_order_details", { order_id: "ORD-999" }, ctx());
  assert.equal(result.status, "not_found");
  assert.equal((result.output as { found: boolean }).found, false);
  assert.equal(result.outcome?.resolution, "NEEDS_INFORMATION");
});

test("guardrail: the model cannot act on an order ID the customer never said", () => {
  const session = newSession();
  const result = executeTool("cancel_order", { order_id: "ORD-103", customer_confirmed: true }, ctx(session, ["ORD-101"]));
  assert.equal(result.status, "blocked");
  assert.deepEqual(session.cancelled, []);
});

test("shipped and delivered orders cannot be cancelled", () => {
  const shipped = executeTool("cancel_order", { order_id: "ORD-101" }, ctx());
  assert.equal(shipped.status, "declined");
  assert.match(shipped.say!, /refuse the delivery at your doorstep/);
  const delivered = executeTool("cancel_order", { order_id: "ORD-102" }, ctx());
  assert.equal(delivered.status, "declined");
  assert.match(delivered.say!, /already been delivered/);
});

test("processing orders need an explicit confirmation before they are cancelled", () => {
  const session = newSession();
  const ask = executeTool("cancel_order", { order_id: "ORD-103", customer_confirmed: true }, ctx(session));
  assert.equal(ask.status, "confirm", "a first call never cancels, even if the model claims confirmation");
  assert.match(ask.say!, /Shall I go ahead\?/);
  assert.equal(session.pendingCancel, "ORD-103");
  assert.deepEqual(session.cancelled, []);

  const done = executeTool("cancel_order", { order_id: "ORD-103", customer_confirmed: true }, ctx(session));
  assert.equal(done.status, "done");
  assert.deepEqual(session.cancelled, ["ORD-103"]);
  assert.equal(findOrder("ORD-103", session)?.status, "Cancelled");
  assert.equal(findOrder("ORD-103", newSession())?.status, "Processing", "fixtures are never mutated");
  assert.equal(executeTool("cancel_order", { order_id: "ORD-103" }, ctx(session)).status, "done", "repeat requests are idempotent");
});

test("returns: late, undelivered and not-yet-shipped orders are declined", () => {
  assert.match(checkReturnEligibility("ORD-102", { is_opened: false }, newSession()).say!, /delivered 14 days ago/);
  assert.equal(checkReturnEligibility("ORD-102", { is_damaged: true, photos_available: true }, newSession()).status, "declined");
  assert.match(checkReturnEligibility("ORD-101", {}, newSession()).say!, /hasn't been delivered yet/);
  assert.match(checkReturnEligibility("ORD-103", {}, newSession()).say!, /cancel it instead/);
});

test("return and damage boundaries follow the policy exactly", () => {
  const order = orders[1];
  const original = order.delivered_days_ago;
  try {
    order.delivered_days_ago = 7;
    assert.equal(checkReturnEligibility("ORD-102", {}, newSession()).status, "needs_info");
    assert.equal(checkReturnEligibility("ORD-102", { is_opened: false, is_unused: true, original_packaging: true }, newSession()).status, "ok");
    assert.equal(checkReturnEligibility("ORD-102", { is_opened: true }, newSession()).status, "declined");
    order.delivered_days_ago = 8;
    assert.equal(checkReturnEligibility("ORD-102", { is_opened: false, is_unused: true, original_packaging: true }, newSession()).status, "declined");
    order.delivered_days_ago = 2;
    assert.equal(checkReturnEligibility("ORD-102", { is_damaged: true }, newSession()).status, "needs_info");
    assert.equal(checkReturnEligibility("ORD-102", { is_damaged: true, photos_available: true }, newSession()).status, "ok");
    order.delivered_days_ago = 3;
    assert.equal(checkReturnEligibility("ORD-102", { is_damaged: true, photos_available: true }, newSession()).status, "declined");
  } finally {
    order.delivered_days_ago = original;
  }
});

test("escalation creates one reference per call", () => {
  const session = newSession();
  const first = executeTool("escalate_to_human", { reason: "Wants a person" }, ctx(session));
  const second = executeTool("escalate_to_human", { reason: "Again" }, ctx(session));
  assert.match(String(first.output.reference), /^AUR-\d{4}$/);
  assert.equal(first.output.reference, second.output.reference);
  assert.equal(session.escalations.length, 1);
});

test("invalid tool calls fail safely", () => {
  assert.equal(executeTool("delete_everything", {}, ctx()).status, "error");
  assert.equal(executeTool("get_order_details", { order_id: 42 }, ctx()).status, "error");
});

test("extra test orders each reach their own policy path", () => {
  const extra = ctx(newSession(), ["ORD-104", "ORD-105", "ORD-106", "ORD-107", "ORD-108"]);
  const facts = { is_opened: false, is_unused: true, original_packaging: true };

  assert.equal(executeTool("cancel_order", { order_id: "ORD-104" }, extra).status, "declined", "shipped: too late to cancel");
  assert.match(checkReturnEligibility("ORD-104", facts, extra.session).say ?? "", /hasn't been delivered yet/, "shipped: too early to return");

  assert.equal(checkReturnEligibility("ORD-105", {}, extra.session).status, "needs_info", "within 7 days: asks about condition");
  assert.equal(checkReturnEligibility("ORD-105", facts, extra.session).status, "ok");

  assert.equal(checkReturnEligibility("ORD-106", { is_damaged: true }, extra.session).status, "needs_info", "damage within 48 h: asks for photos");
  assert.equal(checkReturnEligibility("ORD-106", { is_damaged: true, photos_available: true }, extra.session).status, "ok");

  const kit = executeTool("get_order_details", { order_id: "ORD-107" }, extra).output as { policy: { can_cancel: boolean; cash_on_delivery_eligible: boolean } };
  assert.equal(kit.policy.can_cancel, true);
  assert.equal(kit.policy.cash_on_delivery_eligible, false, "3,200 rupees is above the COD limit");

  assert.equal(checkReturnEligibility("ORD-108", facts, extra.session).status, "ok", "day 7 is still inside the window");
});
