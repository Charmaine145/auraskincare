import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { ShieldCheck } from "lucide-react";
import { adminAvailable, adminConfigured, isAdmin } from "@/lib/admin";
import { computeAnalytics, type AnalyticsRange } from "@/lib/analytics";
import { readDatabase } from "@/lib/store";
import { formatMs } from "@/lib/format";
import { AdminLogin } from "@/components/admin/AdminLogin";
import { AdminLogout } from "@/components/admin/AdminLogout";
import { TicketTable } from "@/components/admin/TicketTable";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "Support analytics · Aria", robots: { index: false, follow: false } };

const RANGES = [
  { id: "7", label: "7 days", days: 7 },
  { id: "30", label: "30 days", days: 30 },
  { id: "90", label: "90 days", days: 90 },
  { id: "all", label: "All time", days: null },
] as const;

const DAY = 24 * 60 * 60 * 1000;
const pct = (value: number | null) => (value === null ? "—" : `${Math.round(value * 100)}%`);
const title = (value: string) => value.toLowerCase().replace(/_/g, " ").replace(/\b\w/g, letter => letter.toUpperCase());

export default async function AdminPage({ searchParams }: { searchParams: Promise<{ range?: string }> }) {
  if (!adminAvailable()) notFound();
  if (!(await isAdmin())) return <AdminLogin configured={adminConfigured()} />;

  const params = await searchParams;
  const selected = RANGES.find(range => range.id === params.range) ?? RANGES[1];
  const to = Date.now();
  const range: AnalyticsRange = {
    from: selected.days === null ? null : to - selected.days * DAY,
    to,
    label: selected.label,
  };
  const db = await readDatabase();
  const analytics = computeAnalytics(db, range);
  const inRange = (at: number) => at >= (range.from ?? 0) && at <= range.to;
  const feedback = db.feedback.filter(item => inRange(item.created_at)).slice().reverse();
  const tickets = db.tickets.filter(item => inRange(item.created_at)).slice().reverse();
  const maxIntent = Math.max(1, ...analytics.intents.map(item => item.count));
  const noData = analytics.conversations.total === 0 && analytics.tickets.total === 0;

  const stats = [
    { label: "Conversations", value: analytics.conversations.total.toLocaleString("en-IN"), hint: `${analytics.conversations.voice} voice · ${analytics.conversations.text} text` },
    { label: "Verified resolution", value: pct(analytics.resolutionRate), hint: `${analytics.conversations.withSummary} completed summaries` },
    { label: "Tool calls", value: analytics.tools.calls.toLocaleString("en-IN"), hint: `${analytics.tools.successful} succeeded · ${analytics.tools.unsuccessful} declined or blocked` },
    { label: "Open tickets", value: analytics.tickets.open.toLocaleString("en-IN"), hint: `${analytics.tickets.total} demo tickets in range` },
    { label: "Avg. response", value: analytics.activity.avgResponseMs === null ? "—" : formatMs(analytics.activity.avgResponseMs), hint: "Measured turns only" },
    { label: "Satisfaction", value: analytics.feedback.average === null ? "—" : `${analytics.feedback.average.toFixed(1)} / 5`, hint: `${analytics.feedback.count} responses` },
    { label: "Cancellations", value: analytics.activity.cancellations.toLocaleString("en-IN"), hint: "Confirmed in-call, not attempts" },
    { label: "Return requests", value: analytics.activity.returnRequests.toLocaleString("en-IN"), hint: "Conversations with a return issue" },
  ];

  return (
    <main className="admin">
      <header className="admin-head">
        <div>
          <p className="admin-kicker"><ShieldCheck size={14} aria-hidden /> Aura Skincare · protected view</p>
          <h1>Support analytics</h1>
          <p className="admin-sub">Built from recorded calls, verified tool outcomes and locally saved tickets and feedback.</p>
        </div>
        <div className="admin-head-actions">
          {adminConfigured() ? <AdminLogout /> : <span className="admin-badge">Local demo access</span>}
        </div>
      </header>

      {!adminConfigured() && (
        <p className="admin-notice">
          Admin access is open because <code>ADMIN_TOKEN</code> is not set and this is not a production build. Set the token before deploying.
        </p>
      )}
      <p className="admin-notice demo">
        All records here come from the sample orders and are marked <strong>demo</strong>. They are not production metrics, and no real customer was contacted.
      </p>

      <nav className="admin-ranges" aria-label="Date range">
        {RANGES.map(item => (
          <a key={item.id} href={`?range=${item.id}`} aria-current={item.id === selected.id ? "page" : undefined} className={item.id === selected.id ? "on" : ""}>{item.label}</a>
        ))}
      </nav>

      {noData && (
        <section className="admin-empty-card">
          <h2>No records in this range yet</h2>
          <p>Finish a call in the demo to create a summary, tool record, ticket or rating. Empty ranges show zeroes instead of failing.</p>
        </section>
      )}

      <section className="admin-stats" aria-label="Key metrics">
        {stats.map(stat => (
          <div key={stat.label} className="admin-stat">
            <span>{stat.label}</span>
            <strong>{stat.value}</strong>
            <small>{stat.hint}</small>
          </div>
        ))}
      </section>

      <div className="admin-grid">
        <section className="admin-panel">
          <h2>Customer intents</h2>
          {analytics.intents.length ? (
            <ul className="admin-bars">
              {analytics.intents.map(item => (
                <li key={item.intent}>
                  <span>{title(item.intent)}</span>
                  <span className="admin-bar" aria-hidden><i style={{ width: `${Math.round((item.count / maxIntent) * 100)}%` }} /></span>
                  <b>{item.count}</b>
                </li>
              ))}
            </ul>
          ) : <p className="admin-empty">No intents recorded in this range.</p>}
        </section>

        <section className="admin-panel">
          <h2>Verified tool outcomes</h2>
          {analytics.tools.byTool.length ? (
            <table className="admin-table compact">
              <thead><tr><th>Tool</th><th>Calls</th><th>Succeeded</th><th>Declined</th></tr></thead>
              <tbody>
                {analytics.tools.byTool.map(row => (
                  <tr key={row.name}><td className="mono">{row.name}</td><td>{row.calls}</td><td>{row.successful}</td><td>{row.declined}</td></tr>
                ))}
              </tbody>
            </table>
          ) : <p className="admin-empty">No tool calls recorded in this range.</p>}
        </section>

        <section className="admin-panel">
          <h2>Resolutions</h2>
          {analytics.resolutions.length ? (
            <ul className="admin-bars">
              {analytics.resolutions.map(item => (
                <li key={item.status}>
                  <span>{title(item.status)}</span>
                  <span className="admin-bar" aria-hidden><i style={{ width: `${Math.round((item.count / Math.max(1, analytics.conversations.total)) * 100)}%` }} /></span>
                  <b>{item.count}</b>
                </li>
              ))}
            </ul>
          ) : <p className="admin-empty">No completed calls in this range.</p>}
          <p className="admin-footnote">{analytics.activity.turns} turns logged · {analytics.activity.turnErrors} turn errors · {analytics.activity.escalations} follow-ups flagged</p>
        </section>

        <section className="admin-panel">
          <h2>Satisfaction</h2>
          {analytics.feedback.count ? (
            <>
              <p className="admin-big">{analytics.feedback.average?.toFixed(1)} <small>/ 5 from {analytics.feedback.count} ratings</small></p>
              <ul className="admin-bars">
                {[...analytics.feedback.distribution].reverse().map(item => (
                  <li key={item.rating}>
                    <span>{item.rating} star{item.rating === 1 ? "" : "s"}</span>
                    <span className="admin-bar" aria-hidden><i style={{ width: `${Math.round((item.count / Math.max(1, analytics.feedback.count)) * 100)}%` }} /></span>
                    <b>{item.count}</b>
                  </li>
                ))}
              </ul>
            </>
          ) : <p className="admin-empty">No ratings yet. Feedback is optional.</p>}
        </section>
      </div>

      <section className="admin-panel">
        <h2>Support tickets</h2>
        <TicketTable tickets={tickets} />
      </section>

      <section className="admin-panel">
        <h2>Recent feedback</h2>
        {feedback.length ? (
          <ul className="admin-feedback">
            {feedback.map(item => (
              <li key={item.id}>
                <div><strong>{item.rating} / 5</strong><span>{item.brand} · {new Date(item.created_at).toLocaleString("en-IN", { dateStyle: "medium", timeStyle: "short" })}</span></div>
                <p>{item.comment || "No written comment."}</p>
              </li>
            ))}
          </ul>
        ) : <p className="admin-empty">No feedback in this range.</p>}
      </section>

      <footer className="admin-footer">
        <span>Demo data only · no transcripts or contact details are stored.</span>
        <a href="/">Back to Aria</a>
      </footer>
    </main>
  );
}
