import type { Intent, TicketCategory } from "@/types";

/** Maps a call's intent to a support-ticket category, shared by tools and the store adapter. */
export function categoryFor(intent: Intent): TicketCategory {
  switch (intent) {
    case "ORDER_TRACKING":
    case "CANCELLATION":
      return "Delivery Issue";
    case "RETURN_REQUEST":
      return "Return Request";
    case "DAMAGED_PRODUCT":
      return "Damaged Product";
    case "POLICY_QUESTION":
      return "Payment Query";
    default:
      return "Other";
  }
}

/** An escalation keeps the reason's category when the caller's own words make it clear. */
export function ticketCategory(intent: Intent, reason: string): TicketCategory {
  if (intent !== "HUMAN_HANDOFF") return categoryFor(intent);
  const text = reason.toLowerCase();
  if (/\b(damag|broken|defect|leak|spill|crack)/.test(text)) return "Damaged Product";
  if (/\b(return|refund|replace|exchange)/.test(text)) return "Return Request";
  if (/\b(deliver|ship|track|courier|late|delay|parcel|order)/.test(text)) return "Delivery Issue";
  if (/\b(cod|cash|upi|pay|payment|charge|fee)/.test(text)) return "Payment Query";
  return "Other";
}
