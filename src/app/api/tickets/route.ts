import { z } from "zod";
import { isAdmin } from "@/lib/admin";
import { checkRateLimit } from "@/lib/rateLimit";
import { verifyTicketToken } from "@/lib/session";
import { getTicket, updateTicket } from "@/lib/store";
import type { TicketStatus } from "@/types";
import { readBody } from "@/lib/validation";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const STATUSES = ["Open", "In Progress", "Resolved", "Closed"] as const;
const statusSchema = z.enum(STATUSES);
const patchSchema = z.object({ reference: z.string().trim().min(3).max(40), status: statusSchema }).strict();

/**
 * Customer status lookup: needs both the reference and its signed token, so a guessed
 * four-digit reference cannot read another caller's ticket. Admin updates use PATCH.
 */
export async function GET(request: Request) {
  if (!checkRateLimit(request, "tickets")) return Response.json({ error: "Too many requests. Please try again later." }, { status: 429 });
  const url = new URL(request.url);
  const reference = url.searchParams.get("reference")?.trim() ?? "";
  const token = url.searchParams.get("token")?.trim() ?? "";
  if (!reference || !token || !verifyTicketToken(reference, token)) return Response.json({ error: "Ticket not found." }, { status: 404 });
  const ticket = await getTicket(reference);
  if (!ticket) return Response.json({ error: "Ticket not found." }, { status: 404 });
  return Response.json({
    ticket: {
      reference: ticket.reference,
      category: ticket.category,
      status: ticket.status,
      order_id: ticket.order_id,
      reason: ticket.reason,
      created_at: ticket.created_at,
      updated_at: ticket.updated_at,
      demo: true,
    },
  });
}

export async function PATCH(request: Request) {
  if (!(await isAdmin())) return Response.json({ error: "Not authorised." }, { status: 401 });
  if (!checkRateLimit(request, "tickets-admin")) return Response.json({ error: "Too many requests." }, { status: 429 });
  let input: z.infer<typeof patchSchema>;
  try {
    input = patchSchema.parse(await readBody(request));
  } catch {
    return Response.json({ error: "Choose a valid ticket and status." }, { status: 400 });
  }
  try {
    const ticket = await updateTicket(input.reference, input.status as TicketStatus);
    if (!ticket) return Response.json({ error: "Ticket not found." }, { status: 404 });
    return Response.json({ ticket: { reference: ticket.reference, status: ticket.status } });
  } catch {
    return Response.json({ error: "The ticket could not be updated on this server." }, { status: 503 });
  }
}
