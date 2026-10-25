"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import type { StoredTicket } from "@/lib/store";
import type { TicketStatus } from "@/types";

const STATUSES: TicketStatus[] = ["Open", "In Progress", "Resolved", "Closed"];

/** Admin-only ticket triage. The route re-checks the admin cookie on every update. */
export function TicketTable({ tickets }: { tickets: StoredTicket[] }) {
  const router = useRouter();
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const change = async (reference: string, status: TicketStatus) => {
    setBusy(reference);
    setError(null);
    try {
      const response = await fetch("/api/tickets", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ reference, status }),
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(data.error || "Update failed.");
      router.refresh();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Update failed.");
    } finally {
      setBusy(null);
    }
  };

  if (!tickets.length) {
    return <p className="admin-empty">No tickets yet. Escalations made during a call appear here, marked as demo records.</p>;
  }

  return (
    <>
      {error && <p className="admin-error" role="alert">{error}</p>}
      <div className="admin-table-wrap">
        <table className="admin-table">
          <thead>
            <tr><th>Reference</th><th>Category</th><th>Order</th><th>Issue</th><th>Created</th><th>Status</th></tr>
          </thead>
          <tbody>
            {tickets.map(ticket => (
              <tr key={`${ticket.sid}-${ticket.reference}`}>
                <td className="mono">{ticket.reference}<span className="admin-demo">demo</span></td>
                <td>{ticket.category}</td>
                <td className="mono">{ticket.order_id ?? "—"}</td>
                <td className="admin-reason">{ticket.reason}</td>
                <td>{new Date(ticket.created_at).toLocaleString("en-IN", { dateStyle: "medium", timeStyle: "short" })}</td>
                <td>
                  <select
                    aria-label={`Status for ticket ${ticket.reference}`}
                    value={ticket.status}
                    disabled={busy === ticket.reference}
                    onChange={event => void change(ticket.reference, event.target.value as TicketStatus)}
                  >
                    {STATUSES.map(status => <option key={status} value={status}>{status}</option>)}
                  </select>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </>
  );
}
