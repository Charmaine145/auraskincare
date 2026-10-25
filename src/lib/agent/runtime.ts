import { normalizeOrderId } from "@/lib/orders/orderIds";
import type { AgentEvent, ReplySource, SessionData, ToolName, ToolStatus, TurnOutcome, VerifiedToolResult } from "@/types";
import { executeTool, type ToolContext, type ToolExecution } from "./tools";

export type Emit = (event: AgentEvent) => void;

export interface TurnResult {
  reply: string;
  source: ReplySource;
  endCall: boolean;
}

const MAX_OUTCOMES = 60;
const MAX_TOOL_RESULTS = 80;

export function recordOutcome(session: SessionData, outcome: TurnOutcome) {
  session.outcomes.push(outcome);
  if (session.outcomes.length > MAX_OUTCOMES) session.outcomes.splice(0, session.outcomes.length - MAX_OUTCOMES);
}

/**
 * Records the verified result inside the signed session. The recap reads only this list for
 * transaction claims, so a model's wording can never turn an attempt into a success.
 */
function recordToolResult(session: SessionData, name: ToolName, result: ToolExecution, args: Record<string, unknown>, ms: number) {
  const fromArgs = typeof args.order_id === "string" ? normalizeOrderId(args.order_id) : null;
  const entry: VerifiedToolResult = {
    name,
    status: result.status,
    order_id: result.outcome?.order_id ?? fromArgs,
    summary: result.summary,
    ms,
  };
  session.toolResults ??= [];
  session.toolResults.push(entry);
  if (session.toolResults.length > MAX_TOOL_RESULTS) {
    session.toolResults.splice(0, session.toolResults.length - MAX_TOOL_RESULTS);
  }
}

/** Executes a tool, streams it to the activity panel and records its verified outcome. */
export function runTool(name: string, args: Record<string, unknown>, ctx: ToolContext, emit: Emit): ToolExecution {
  const id = crypto.randomUUID();
  emit({ type: "tool_call", id, name: name as ToolName, args });
  const started = performance.now();
  const result = executeTool(name, args, ctx);
  const ms = Math.round(performance.now() - started);
  emit({ type: "tool_result", id, name: name as ToolName, status: result.status, summary: result.summary, ms });
  if (result.status === "blocked") emit({ type: "guardrail", rule: "Order-ID provenance", detail: result.summary });
  recordToolResult(ctx.session, name as ToolName, result, args, ms);
  if (result.outcome) recordOutcome(ctx.session, result.outcome);
  return result;
}
