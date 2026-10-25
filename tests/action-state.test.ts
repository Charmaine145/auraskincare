import { test } from "node:test";
import assert from "node:assert/strict";
import {
  applyActionResult,
  markActionUnresolved,
  markTurnUnresolved,
  reconcileCancelled,
  recordAction,
  startAction,
  supersedeConfirmations,
  type ActionRecord,
} from "../src/lib/agent/actionState";
import type { ToolStatus } from "../src/types";

const call = (id: string, name: ActionRecord["name"], args: Record<string, unknown> = { order_id: "ORD-103" }) =>
  startAction({ type: "tool_call", id, name, args }, 1);

const result = (id: string, name: ActionRecord["name"], status: ToolStatus, summary: string, ms = 4) =>
  applyActionResult([call(id, name)], { type: "tool_result", id, name, status, summary, ms });

test("action: a tool call starts pending with a human label and order id", () => {
  const action = call("a1", "cancel_order");
  assert.equal(action.state, "pending");
  assert.equal(action.title, "Cancellation check · ORD-103");
  assert.equal(action.orderId, "ORD-103");
  assert.equal(action.turn, 1);
  assert.match(action.detail, /waiting/i);
});

test("action: a repeated tool-call id never creates a duplicate row", () => {
  const first = call("a1", "get_order_details");
  const actions = recordAction(recordAction([], first), call("a1", "get_order_details"));
  assert.equal(actions.length, 1);
});

test("action: a confirmed cancellation is labelled apart from its policy check", () => {
  const check = call("a1", "cancel_order", { order_id: "ORD-103", customer_confirmed: false });
  const confirmed = call("a2", "cancel_order", { order_id: "ORD-103", customer_confirmed: true });
  assert.equal(check.title, "Cancellation check · ORD-103");
  assert.equal(confirmed.title, "Cancellation · ORD-103");
});

test("action: a validated lookup or completed transaction is confirmed", () => {
  const lookup = result("a1", "get_order_details", "ok", "ORD-103: Out for delivery");
  assert.equal(lookup[0].state, "confirmed");
  assert.equal(lookup[0].detail, "ORD-103: Out for delivery");
  assert.equal(lookup[0].ms, 4);

  const cancelled = result("a2", "cancel_order", "done", "Cancelled after confirmation");
  assert.equal(cancelled[0].state, "confirmed");
});

test("action: a confirmation prompt is unconfirmed, whatever the summary says", () => {
  const actions = result("a1", "cancel_order", "confirm", "Cancelled after confirmation");
  assert.equal(actions[0].state, "unconfirmed");
  assert.equal(actions[0].awaitingConfirmation, true);
  assert.match(actions[0].detail, /Nothing has been changed/i);
});

test("action: missing details and policy refusals are reported honestly", () => {
  assert.equal(result("a1", "check_return_eligibility", "needs_info", "Within 30 days: checking condition")[0].state, "unconfirmed");
  for (const status of ["not_found", "declined", "blocked", "error"] as ToolStatus[]) {
    assert.equal(result("a1", "cancel_order", status, "No order ORD-999 in the database")[0].state, "failed");
  }
});

test("action: a tool that never returns is unconfirmed, never confirmed", () => {
  const actions = markActionUnresolved([call("a1", "get_order_details")], "a1");
  assert.equal(actions[0].state, "unconfirmed");
  assert.match(actions[0].detail, /outcome is unknown/i);
});

test("action: ending a turn only affects its own pending calls", () => {
  const other = startAction({ type: "tool_call", id: "b1", name: "get_order_details", args: { order_id: "ORD-101" } }, 2);
  const done = applyActionResult([call("a1", "get_order_details")], {
    type: "tool_result", id: "a1", name: "get_order_details", status: "ok", summary: "ORD-103: Shipped", ms: 3,
  });
  const actions = markTurnUnresolved([...done, other], 1);
  assert.equal(actions[0].state, "confirmed");
  assert.equal(actions[1].state, "pending");
});

test("action: moving on without a yes leaves the prompt unconfirmed", () => {
  const actions = supersedeConfirmations(result("a1", "cancel_order", "confirm", "Eligible"), 2);
  assert.equal(actions[0].state, "unconfirmed");
  assert.equal(actions[0].awaitingConfirmation, false);
  assert.equal(actions[0].detail, "Not confirmed. Nothing was changed.");
});

test("action: the signed cancelled list confirms only cancellation actions for that order", () => {
  const cancellation = result("a1", "cancel_order", "confirm", "Eligible");
  const lookup = startAction({ type: "tool_call", id: "a2", name: "get_order_details", args: { order_id: "ORD-103" } }, 1);
  const otherOrder = startAction({ type: "tool_call", id: "a3", name: "cancel_order", args: { order_id: "ORD-101" } }, 1);
  const actions = reconcileCancelled([...cancellation, lookup, otherOrder], ["ORD-103"]);

  assert.equal(actions[0].state, "confirmed");
  assert.match(actions[0].detail, /Confirmed by the server/i);
  assert.equal(actions[1].state, "pending");
  assert.equal(actions[2].state, "pending");
});
