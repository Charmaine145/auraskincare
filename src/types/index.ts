export type AgentState = "Idle" | "Listening" | "Thinking" | "Speaking";

export type OrderStatus = "Processing" | "Shipped" | "Out for Delivery" | "Delivered" | "Cancelled";

export interface Order {
  order_id: string;
  customer_name: string;
  product: string;
  /** Order value in rupees. */
  value: number;
  status: OrderStatus;
  courier?: string;
  tracking_id?: string;
  notes: string;
  ordered_hours_ago?: number;
  delivered_days_ago?: number;
}

export type Intent =
  | "ORDER_TRACKING"
  | "CANCELLATION"
  | "RETURN_REQUEST"
  | "DAMAGED_PRODUCT"
  | "POLICY_QUESTION"
  | "PRODUCT_QUESTION"
  | "HUMAN_HANDOFF"
  | "OUT_OF_SCOPE"
  | "GENERAL";

/** Where an escalated conversation sits in the (local, demo) support queue. */
export type TicketCategory = "Delivery Issue" | "Return Request" | "Damaged Product" | "Payment Query" | "Other";
export type TicketStatus = "Open" | "In Progress" | "Resolved" | "Closed";

/** Customer-visible ticket fields. No transcript or contact details are exposed. */
export interface TicketView {
  reference: string;
  category: TicketCategory;
  status: TicketStatus;
  order_id: string | null;
  reason: string;
  created_at: number;
  /** Short signature so a reference alone can't be used to read someone else's ticket. */
  token: string;
  /** False when this host could not write the ticket to disk. */
  persisted?: boolean;
  demo: true;
}

export type Resolution = "RESOLVED" | "POLICY_DECLINED" | "NEEDS_INFORMATION" | "ESCALATED" | "UNRESOLVED";

/** One verified thing that happened in a call. Written by the server, never by the model. */
export interface TurnOutcome {
  intent: Intent;
  order_id: string | null;
  resolution: Resolution;
  /** Third-person fact, e.g. "Cancelled ORD-103 after the customer confirmed." */
  detail: string;
}

export interface Escalation {
  reference: string;
  reason: string;
  order_id: string | null;
  /** Added with the ticket workflow; older signed sessions simply leave it out. */
  category?: TicketCategory;
  status?: TicketStatus;
  created_at?: number;
}

/** Per-call state. Travels between browser and server inside an HMAC-signed token. */
export interface SessionData {
  v: 2;
  expires: number;
  /** Random call id, used to link summaries, tickets and feedback without personal data. */
  sid?: string;
  /** Wall-clock start, used for analytics and ticket timestamps. */
  startedAt?: number;
  /** Brand this call is for (a BrandId); fixed for the whole call. Absent in older tokens: Aura. */
  brand?: string;
  cancelled: string[];
  outcomes: TurnOutcome[];
  escalations: Escalation[];
  toolCalls: number;
  lastOrder?: string;
  /** Order waiting for the customer's yes/no before it is cancelled. */
  pendingCancel?: string;
  /** Rule-based mode only: the request that is waiting for an order ID. */
  pendingIntent?: Intent;
  /**
   * Server-verified tool results for this call, recorded by the tool runner inside the signed
   * session. Recaps use these for transaction claims instead of trusting generated prose.
   * Optional so sessions signed before recaps existed still load.
   */
  toolResults?: VerifiedToolResult[];
}

export type ChatRole = "user" | "assistant";
export interface ChatMessage {
  role: ChatRole;
  content: string;
}

export type ToolName = "get_order_details" | "cancel_order" | "check_return_eligibility" | "escalate_to_human" | "find_products";
export type ToolStatus = "ok" | "not_found" | "declined" | "needs_info" | "confirm" | "done" | "blocked" | "error";

/** One verified tool execution. Written by the server tool runner, never by the model. */
export interface VerifiedToolResult {
  name: ToolName;
  status: ToolStatus;
  order_id: string | null;
  /** Server-authored summary, e.g. "ORD-103: Processing". */
  summary: string;
  ms: number;
}

/** Events streamed from /api/chat while Aria works on a turn. */
export type AgentEvent =
  | { type: "tool_call"; id: string; name: ToolName; args: Record<string, unknown> }
  | { type: "tool_result"; id: string; name: ToolName; status: ToolStatus; summary: string; ms: number }
  | { type: "guardrail"; rule: string; detail: string }
  | { type: "model"; model: string; round: number; ms: number };

/** model: worded by the LLM · policy: a server policy decision · direct: facts from a lookup, no model call · rules: keyless demo mode. */
export type ReplySource = "model" | "policy" | "direct" | "rules";

export type ChatStreamEvent =
  | AgentEvent
  | { type: "reply"; text: string; source: ReplySource }
  | { type: "done"; session: string; mode: "ai" | "demo"; cancelled: string[]; endCall: boolean; ms: number; tickets?: TicketView[] }
  | { type: "error"; message: string };

/** One attempted tool-backed action, derived from the verified server result. */
export interface RecapAction {
  action: string;
  order_id: string | null;
  result: "confirmed" | "failed" | "unconfirmed";
  detail: string;
}

/**
 * Structured post-call recap. Every transaction claim here comes from the signed session's
 * verified tool results; the model only contributes the narrative and classification.
 */
export interface CallRecap {
  issue: string;
  /** Only an order this brand is allowed to discuss, never just any ID in the transcript. */
  order_reference: string | null;
  key_points: string[];
  attempted_actions: RecapAction[];
  verified_outcomes: string[];
  unresolved_issues: string[];
  next_steps: string[];
}

export interface CallSummary {
  /** Brand the call was for. */
  brand: string;
  customer_intent: Intent;
  order_id: string | null;
  resolution_status: Resolution | "NO_CONVERSATION";
  call_summary: string;
  customer_sentiment: "POSITIVE" | "NEUTRAL" | "NEGATIVE";
  follow_up_required: boolean;
  issues: { intent: Intent; order_id: string | null; resolution: Resolution }[];
  actions_taken: string[];
  order_ids: string[];
  metrics: { customer_turns: number; tool_calls: number; duration_seconds: number | null; avg_response_ms: number | null };
  generated_by: string;
  /** Added with the downloadable recap; absent on records stored before it existed. */
  recap?: CallRecap;
}

export type VoiceProviderId = "edge" | "azure" | "sarvam" | "openai" | "gemini";

export interface AppConfig {
  mode: "ai" | "demo";
  provider: string | null;
  model: string | null;
  modelLabel: string | null;
  /** First configured premium voice provider; null means the browser's own voice. */
  voiceProvider: VoiceProviderId | null;
  voices: { id: string; label: string; description: string }[];
  defaultVoice: string | null;
  /** Natural server voice for each Indian language it covers, e.g. { "hi-IN": "Swara" }. */
  voiceLanguages: Record<string, string>;
  cloudTranscription: boolean;
}
