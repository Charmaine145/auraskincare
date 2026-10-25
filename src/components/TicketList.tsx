"use client";

import { useState } from "react";
import { CircleCheck, Headphones, RefreshCw, TriangleAlert } from "lucide-react";
import type { TicketView } from "@/types";

/** Customer-visible demo ticket details. No transcript, contact details or admin controls. */
export function TicketList({ tickets }: { tickets: TicketView[] }) {
  const [updates, setUpdates] = useState<Record<string, { status?: string; error?: string; loading?: boolean }>>({});
  if (!tickets.length) return null;

  const refresh = async (ticket: TicketView) => {
    setUpdates(current => ({ ...current, [ticket.reference]: { loading: true } }));
    try {
      const response = await fetch(`/api/tickets?reference=${encodeURIComponent(ticket.reference)}&token=${encodeURIComponent(ticket.token)}`);
      const data = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(data.error || "Status unavailable");
      setUpdates(current => ({ ...current, [ticket.reference]: { status: data.ticket?.status } }));
    } catch (error) {
      setUpdates(current => ({ ...current, [ticket.reference]: { error: error instanceof Error ? error.message : "Status unavailable" } }));
    }
  };

  return (
    <div className="summary-block">
      <h3><Headphones size={14} aria-hidden /> Support tickets</h3>
      <ul className="tickets">
        {tickets.map(ticket => {
          const update = updates[ticket.reference];
          return (
            <li key={ticket.reference}>
              <div className="ticket-line">
                <strong className="mono">{ticket.reference}</strong>
                <span className={`badge ${ticket.status === "Resolved" || ticket.status === "Closed" ? "delivered" : "transit"}`}>
                  {update?.status ?? ticket.status}
                </span>
              </div>
              <p className="ticket-meta">
                {ticket.category}
                {ticket.order_id && <> · <span className="mono">{ticket.order_id}</span></>}
              </p>
              <p className="ticket-reason">{ticket.reason}</p>
              <div className="ticket-foot">
                <span>Demo ticket · no human agent has been contacted.</span>
                <button className="chip-btn" onClick={() => void refresh(ticket)} disabled={update?.loading}>
                  <RefreshCw size={12} className={update?.loading ? "spin" : ""} /> {update?.loading ? "Checking" : "Check status"}
                </button>
              </div>
              {ticket.persisted === false && (
                <p className="ticket-warn"><TriangleAlert size={12} aria-hidden /> This ticket isn&apos;t saved on this server, so its status can&apos;t change.</p>
              )}
              {update?.error && <p className="ticket-warn">{update.error}</p>}
            </li>
          );
        })}
      </ul>
    </div>
  );
}

export function FeedbackSaved({ rating }: { rating: number }) {
  return (
    <p className="feedback-saved" role="status">
      <CircleCheck size={14} aria-hidden /> Thank you — your {rating}-star feedback was saved.
    </p>
  );
}
