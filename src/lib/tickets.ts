import type { SessionData, TicketCategory, TicketView } from "@/types";
import { saveTicket } from "./store";
import { ticketToken } from "./session";
import { ticketCategory } from "./ticketCategory";

/**
 * Turns the signed call's escalations into locally recorded demo tickets.
 * Saving is idempotent, so a retried turn cannot create a second ticket.
 */

const view = (ticket: { reference: string; category: TicketCategory; status: string; order_id: string | null; reason: string; created_at: number }, persisted: boolean): TicketView => ({
  reference: ticket.reference,
  category: ticket.category,
  status: ticket.status as TicketView["status"],
  order_id: ticket.order_id,
  reason: ticket.reason,
  created_at: ticket.created_at,
  token: ticketToken(ticket.reference),
  persisted,
  demo: true,
});

export async function persistEscalations(session: SessionData): Promise<TicketView[]> {
  if (!session.escalations.length) return [];
  const sid = session.sid ?? "unknown-call";
  const brand = session.brand ?? "aura";
  const views: TicketView[] = [];
  for (const escalation of session.escalations) {
    const category = escalation.category ?? ticketCategory("HUMAN_HANDOFF", escalation.reason);
    try {
      const ticket = await saveTicket({
        reference: escalation.reference,
        sid,
        brand,
        category,
        reason: escalation.reason,
        order_id: escalation.order_id,
        created_at: escalation.created_at,
      });
      views.push(view(ticket, true));
    } catch {
      // Read-only host: still show the signed session's reference, but mark it as unsaved.
      views.push(view({
        reference: escalation.reference,
        category,
        status: escalation.status ?? "Open",
        order_id: escalation.order_id,
        reason: escalation.reason,
        created_at: escalation.created_at ?? Date.now(),
      }, false));
    }
  }
  return views;
}
