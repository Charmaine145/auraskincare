import { normalizeOrderId } from "@/lib/orders/orderIds";
import type { AgentEvent, ToolName, ToolStatus } from "@/types";

/**
 * Customer-facing state for one tool-backed action.
 *
 * Every value comes from the server's `tool_call` / `tool_result` events or the signed
 * `done.cancelled` list. A reply's wording is never used, so Aria cannot make a failed or
 * unfinished action look completed.
 *
 *   pending      the server is working on it (or the customer is still waiting)
 *   confirmed    the server returned a validated result / completed the action
 *   failed       the server refused it, could not find the record, or errored
 *   unconfirmed  no final result: awaiting confirmation, more details, timeout or disconnect
 */
export type ActionState = "pending" | "confirmed" | "failed" | "unconfirmed";

export interface ActionRecord {
  /** Tool-call id from the server; unique within a call. */
  id: string;
  /** Customer turn that started this action. */
  turn: number;
  name: ToolName;
  /** Normalised order ID when the tool acted on one. */
  orderId?: string;
  /** Human label, e.g. "Cancellation · ORD-103". */
  title: string;
  state: ActionState;
  /** Verified server summary, or an honest note about an unknown outcome. */
  detail: string;
  ms?: number;
  /** The tool is waiting for the customer's explicit confirmation. */
  awaitingConfirmation?: boolean;
}

export const ACTION_STATE_LABEL: Record<ActionState, string> = {
  pending: "Pending",
  confirmed: "Confirmed",
  failed: "Failed",
  unconfirmed: "Unconfirmed",
};

/** Keeps the live panel bounded on long calls. */
const MAX_ACTIONS = 60;

const orderIdOf = (args: Record<string, unknown>): string | undefined => {
  const value = args.order_id;
  return typeof value === "string" && value.trim() ? normalizeOrderId(value) : undefined;
};

/** A short, stable label that tells the customer what was checked or changed. */
export function actionTitle(name: ToolName, args: Record<string, unknown>): string {
  const id = orderIdOf(args);
  switch (name) {
    case "get_order_details":
      return id ? `Order lookup · ${id}` : "Order lookup";
    case "cancel_order": {
      // A policy check and the confirmed cancellation are separate tool calls; label them apart.
      const verb = args.customer_confirmed === true ? "Cancellation" : "Cancellation check";
      return id ? `${verb} · ${id}` : verb;
    }
    case "check_return_eligibility":
      return id ? `Return check · ${id}` : "Return check";
    case "escalate_to_human":
      return "Care-team handoff";
    case "find_products":
      return "Product search";
  }
}

/**
 * Maps a validated tool status to a customer-facing state.
 * `confirm` is deliberately unconfirmed: the server has only asked for permission.
 */
export function outcomeFor(status: ToolStatus, summary: string): Pick<ActionRecord, "state" | "detail" | "awaitingConfirmation"> {
  switch (status) {
    case "ok":
    case "done":
      return { state: "confirmed", detail: summary };
    case "confirm":
      return {
        state: "unconfirmed",
        detail: "Waiting for your confirmation. Nothing has been changed yet.",
        awaitingConfirmation: true,
      };
    case "needs_info":
      return { state: "unconfirmed", detail: summary };
    case "not_found":
    case "declined":
    case "blocked":
    case "error":
      return { state: "failed", detail: summary };
    default:
      return { state: "failed", detail: summary || "The server returned an unexpected result." };
  }
}

/** Starts a pending action from the streamed `tool_call` event. */
export function startAction(event: Extract<AgentEvent, { type: "tool_call" }>, turn: number): ActionRecord {
  return {
    id: event.id,
    turn,
    name: event.name,
    orderId: orderIdOf(event.args),
    title: actionTitle(event.name, event.args),
    state: "pending",
    detail: "Waiting for the server to check this.",
  };
}

/** Adds an action once; a repeated `tool_call` id never creates a duplicate row. */
export function recordAction(actions: ActionRecord[], action: ActionRecord): ActionRecord[] {
  if (actions.some(item => item.id === action.id)) return actions;
  const next = [...actions, action];
  return next.length > MAX_ACTIONS ? next.slice(-MAX_ACTIONS) : next;
}

/** Applies the validated `tool_result`; unmatched results (e.g. after a reset) are ignored. */
export function applyActionResult(actions: ActionRecord[], event: Extract<AgentEvent, { type: "tool_result" }>): ActionRecord[] {
  const outcome = outcomeFor(event.status, event.summary);
  return actions.map(action => (action.id === event.id ? { ...action, ...outcome, ms: event.ms } : action));
}

/** A single tool that never returned: its outcome is unknown, never a success. */
export function markActionUnresolved(actions: ActionRecord[], id: string, detail = "No result arrived from the server. The outcome is unknown, so nothing is confirmed."): ActionRecord[] {
  return actions.map(action => (action.id === id && action.state === "pending" ? { ...action, state: "unconfirmed", detail } : action));
}

/** A turn that ended (timeout, disconnect or hang-up) leaves its pending calls unconfirmed. */
export function markTurnUnresolved(actions: ActionRecord[], turn: number, detail = "The check ended before the server returned a result. Nothing is confirmed."): ActionRecord[] {
  return actions.map(action => (action.turn === turn && action.state === "pending" ? { ...action, state: "unconfirmed", detail } : action));
}

/**
 * A confirmation prompt lapses once the customer moves on. It stays unconfirmed because the
 * server never cancelled anything.
 */
export function supersedeConfirmations(actions: ActionRecord[], nextTurn: number, detail = "Not confirmed. Nothing was changed."): ActionRecord[] {
  return actions.map(action =>
    action.awaitingConfirmation && action.turn < nextTurn
      ? { ...action, state: "unconfirmed", awaitingConfirmation: false, detail }
      : action,
  );
}

/**
 * The signed session's `cancelled` list is authoritative. It can only confirm a cancellation
 * action for an order the server says is cancelled; lookups, returns and other tools are never
 * promoted by it.
 */
export function reconcileCancelled(actions: ActionRecord[], cancelled: string[]): ActionRecord[] {
  const ids = new Set(cancelled.map(normalizeOrderId));
  if (ids.size === 0) return actions;
  return actions.map(action =>
    action.name === "cancel_order" && action.orderId && ids.has(action.orderId) && action.state !== "confirmed"
      ? { ...action, state: "confirmed", awaitingConfirmation: false, detail: "Confirmed by the server: this order is cancelled." }
      : action,
  );
}
