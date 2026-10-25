"use client";

import { useState, type ReactNode } from "react";
import { motion, AnimatePresence } from "motion/react";
import {
  Activity,
  AlertCircle,
  ArrowRight,
  Check,
  CheckCircle2,
  Clock,
  Copy,
  Download,
  FileJson,
  FileText,
  HelpCircle,
  MessageSquare,
  Package,
  Phone,
  RotateCcw,
  ShieldCheck,
  Smile,
  Sparkles,
  Zap,
} from "lucide-react";
import type { VoiceCall } from "@/hooks/useVoiceCall";
import { downloadFile, formatClock, formatMs, humanize } from "@/lib/format";
import { RESULT_LABEL, recapMarkdown } from "@/lib/recap";
import type { CallRecap, CallSummary, RecapAction } from "@/types";
import { transcriptText } from "./Conversation";
import { FeedbackPrompt } from "./FeedbackPrompt";
import { TicketList } from "./TicketList";
import { Sheet } from "./ui/Sheet";

const TONE: Record<string, string> = {
  RESOLVED: "delivered",
  POLICY_DECLINED: "processing",
  NEEDS_INFORMATION: "transit",
  ESCALATED: "violet",
  UNRESOLVED: "cancelled",
  NO_CONVERSATION: "muted",
};

const RESULT_TONE: Record<RecapAction["result"], string> = {
  confirmed: "delivered",
  failed: "cancelled",
  unconfirmed: "transit",
};

/** Minimal JSON highlighter: keys, strings, numbers and literals. */
function highlight(json: string): ReactNode[] {
  const out: ReactNode[] = [];
  const pattern = /("(?:\\.|[^"\\])*")(\s*:)?|\b(true|false|null)\b|(-?\d+(?:\.\d+)?)/g;
  let last = 0;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(json))) {
    if (match.index > last) out.push(json.slice(last, match.index));
    const [token, string, colon, literal, number] = match;
    const key = out.length;
    if (string && colon) out.push(<span key={key} className="j-key">{string}</span>, colon);
    else if (string) out.push(<span key={key} className="j-str">{string}</span>);
    else if (literal) out.push(<span key={key} className="j-lit">{literal}</span>);
    else if (number) out.push(<span key={key} className="j-num">{number}</span>);
    else out.push(token);
    last = match.index + token.length;
  }
  out.push(json.slice(last));
  return out;
}

function getIntentIcon(intent: string) {
  switch (intent?.toUpperCase()) {
    case "RETURN_REQUEST":
      return RotateCcw;
    case "ORDER_TRACKING":
      return Package;
    case "CANCELLATION":
      return AlertCircle;
    case "DAMAGED_PRODUCT":
      return AlertCircle;
    case "POLICY_QUESTION":
    case "PRODUCT_QUESTION":
      return HelpCircle;
    case "HUMAN_HANDOFF":
      return Phone;
    default:
      return Sparkles;
  }
}

function getSentimentInfo(sentiment: string) {
  const s = sentiment?.toUpperCase();
  if (s === "POSITIVE") {
    return {
      label: "Positive & Satisfied",
      tone: "delivered",
      description: "Customer expressed satisfaction with the interaction.",
      score: 3,
    };
  }
  if (s === "NEGATIVE" || s === "FRUSTRATED") {
    return {
      label: "Expressed Concern",
      tone: "cancelled",
      description: "Customer expressed urgency or dissatisfaction.",
      score: 1,
    };
  }
  return {
    label: "Neutral & Objective",
    tone: "neutral",
    description: "Customer conversation was clear, transactional, and direct.",
    score: 2,
  };
}

function BentoHero({ summary }: { summary: CallSummary }) {
  const [orderCopied, setOrderCopied] = useState(false);
  const IntentIcon = getIntentIcon(summary.customer_intent);
  const sentiment = getSentimentInfo(summary.customer_sentiment);

  const copyOrderId = async (id: string) => {
    try {
      await navigator.clipboard.writeText(id);
      setOrderCopied(true);
      setTimeout(() => setOrderCopied(false), 1500);
    } catch {
      // ignore
    }
  };

  return (
    <div className="summary-bento-hero">
      {/* Left/Main Column: Executive Inquiry & AI Narrative */}
      <div className="bento-narrative-card">
        <div className="bento-card-header">
          <div className="intent-badge-pill">
            <IntentIcon size={14} className="intent-icon" />
            <span className="intent-title">{humanize(summary.customer_intent)}</span>
          </div>

          {summary.order_id ? (
            <button
              className="order-context-pill"
              onClick={() => summary.order_id && void copyOrderId(summary.order_id)}
              title="Click to copy order reference"
            >
              <Package size={13} />
              <span>
                Order <strong className="mono">{summary.order_id}</strong>
              </span>
              {orderCopied ? (
                <Check size={12} className="text-emerald-400 ml-1" />
              ) : (
                <Copy size={12} className="text-muted ml-1" />
              )}
            </button>
          ) : (
            <span className="order-context-pill muted">No order referenced</span>
          )}
        </div>

        <div className="narrative-body">
          <div className="narrative-quote-icon">
            <Sparkles size={16} />
          </div>
          <p className="narrative-text">{summary.call_summary}</p>
        </div>
      </div>

      {/* Right Column: Interaction Health & Signals */}
      <div className="bento-signals-card">
        {/* Sentiment Signal */}
        <div className="signal-box sentiment-signal">
          <div className="signal-header">
            <span className="signal-tag">Customer Sentiment</span>
            <span className={`sentiment-badge ${sentiment.tone}`}>
              <Smile size={12} />
              <span>{sentiment.label}</span>
            </span>
          </div>
          <p className="signal-description">{sentiment.description}</p>
          <div className="sentiment-meter-bar" aria-hidden>
            <span className={`meter-seg ${sentiment.score >= 1 ? `fill ${sentiment.tone}` : ""}`} />
            <span className={`meter-seg ${sentiment.score >= 2 ? `fill ${sentiment.tone}` : ""}`} />
            <span className={`meter-seg ${sentiment.score >= 3 ? `fill ${sentiment.tone}` : ""}`} />
          </div>
        </div>

        {/* Resolution & Follow-up Signal */}
        <div className="signal-box resolution-signal">
          <div className="signal-header">
            <span className="signal-tag">Outcome Status</span>
            <span className={`badge ${TONE[summary.resolution_status]}`}>
              {humanize(summary.resolution_status)}
            </span>
          </div>
          <div className="followup-status-row">
            {summary.follow_up_required ? (
              <span className="followup-alert">
                <AlertCircle size={13} /> Follow-up ticket logged
              </span>
            ) : (
              <span className="followup-complete">
                <CheckCircle2 size={13} /> Addressed · No action pending
              </span>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

/** Structured recap displaying verified server actions and key points. */
function RecapBlock({ recap }: { recap: CallRecap }) {
  return (
    <div className="recap-stream-wrapper">
      {recap.key_points.length > 0 && (
        <div className="summary-section-card">
          <div className="section-card-head">
            <h4>Key Discussion Points</h4>
          </div>
          <ul className="discussion-points-list">
            {recap.key_points.map((point, i) => (
              <li key={i}>
                <span className="point-bullet" />
                <span>{point}</span>
              </li>
            ))}
          </ul>
        </div>
      )}

      {recap.attempted_actions.length > 0 && (
        <div className="summary-section-card">
          <div className="section-card-head">
            <h4>Server Actions & Verification</h4>
          </div>
          <ul className="recap-actions-list">
            {recap.attempted_actions.map((action, i) => (
              <li key={`${action.action}-${i}`} className="action-row-item">
                <div className="action-info">
                  <span className="action-title">
                    {action.action}
                    {action.order_id && <span className="mono"> · {action.order_id}</span>}
                  </span>
                  <small className="action-detail">{action.detail}</small>
                </div>
                <span className={`badge ${RESULT_TONE[action.result]}`}>
                  {RESULT_LABEL[action.result]}
                </span>
              </li>
            ))}
          </ul>
        </div>
      )}

      {recap.verified_outcomes.length > 0 && (
        <div className="summary-section-card">
          <div className="section-card-head">
            <h4>Verified Outcomes</h4>
          </div>
          <ul className="verified-outcomes-list">
            {recap.verified_outcomes.map((outcome, i) => (
              <li key={i}>
                <CheckCircle2 size={14} className="text-emerald-400 flex-none" />
                <span>{outcome}</span>
              </li>
            ))}
          </ul>
        </div>
      )}

      {recap.unresolved_issues.length > 0 && (
        <div className="summary-section-card warning-tone">
          <div className="section-card-head">
            <h4>Unresolved Matters</h4>
          </div>
          <ul className="unresolved-list">
            {recap.unresolved_issues.map((issue, i) => (
              <li key={i}>
                <AlertCircle size={14} className="text-amber-400 flex-none" />
                <span>{issue}</span>
              </li>
            ))}
          </ul>
        </div>
      )}

      {recap.next_steps.length > 0 && (
        <div className="summary-section-card next-steps-tone">
          <div className="section-card-head">
            <h4>Recommended Next Steps</h4>
          </div>
          <ul className="next-steps-list">
            {recap.next_steps.map((step, i) => (
              <li key={i}>
                <ArrowRight size={14} className="step-arrow-icon" />
                <span>{step}</span>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}

function Overview({ summary }: { summary: CallSummary }) {
  return (
    <div className="summary-overview-flow">
      {/* Hero Bento replacing the 4 flat boxes */}
      <BentoHero summary={summary} />

      {/* Recap block if available */}
      {summary.recap && <RecapBlock recap={summary.recap} />}

      {/* Issues handled if not in recap */}
      {summary.issues.length > 0 && (
        <div className="summary-section-card">
          <div className="section-card-head">
            <h4>Issues Handled</h4>
          </div>
          <ul className="handled-issues-list">
            {summary.issues.map((issue, i) => (
              <li key={i} className="handled-issue-row">
                <div className="handled-issue-title">
                  <span>{humanize(issue.intent)}</span>
                  {issue.order_id && <span className="mono"> · {issue.order_id}</span>}
                </div>
                <span className={`badge ${TONE[issue.resolution]}`}>
                  {humanize(issue.resolution)}
                </span>
              </li>
            ))}
          </ul>
        </div>
      )}

      {!summary.recap && summary.actions_taken.length > 0 && (
        <div className="summary-section-card">
          <div className="section-card-head">
            <h4>Actions Taken</h4>
          </div>
          <ul className="actions-fallback-list">
            {summary.actions_taken.map(action => (
              <li key={action}>
                <Check size={13} className="text-emerald-400 flex-none" />
                <span>{action}</span>
              </li>
            ))}
          </ul>
        </div>
      )}

      {/* Provenance Trust Ribbon */}
      <div className="summary-trust-ribbon">
        <ShieldCheck size={16} className="trust-icon" aria-hidden />
        <div className="trust-copy">
          <strong>Verified Audit Trail</strong>
          <span>
            {summary.generated_by === "rules"
              ? "All actions, orders, and outcomes validated strictly against server-side policy engines."
              : `Written by ${summary.generated_by}; order IDs, actions, and outcomes verified from the backend tool logs.`}
          </span>
        </div>
      </div>
    </div>
  );
}

export function SummarySheet({
  call,
  open,
  onClose,
}: {
  call: VoiceCall;
  open: boolean;
  onClose: () => void;
}) {
  const [tab, setTab] = useState<"overview" | "json">("overview");
  const [copied, setCopied] = useState(false);
  const summary = call.summary;
  const json = summary ? JSON.stringify(summary, null, 2) : "";

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(json);
      setCopied(true);
      setTimeout(() => setCopied(false), 1600);
    } catch {
      setTab("json");
    }
  };

  return (
    <Sheet
      open={open && Boolean(summary)}
      onClose={onClose}
      width={780}
      className="summary-sheet-custom"
      title={
        summary && (
          <div className="summary-header-main">
            <div className="summary-badge-line">
              <span className="brand-intel-badge">
                <Sparkles size={12} className="sparkle-icon" />
                AURA CONVERSATION INTELLIGENCE
              </span>
              <span className="verified-shield-pill">
                <ShieldCheck size={12} />
                Verified Session
              </span>
            </div>
            <div className="summary-title-row">
              <h2 className="summary-headline">Post-Call Intelligence</h2>
              <span className={`summary-status-pill ${TONE[summary.resolution_status]}`}>
                {humanize(summary.resolution_status)}
              </span>
            </div>
          </div>
        )
      }
      footer={
        <div className="summary-footer-bar">
          <div className="footer-export-group">
            <button
              className="footer-tool-btn"
              onClick={() => void copy()}
              title="Copy structured JSON payload"
            >
              {copied ? <Check size={14} className="text-emerald-400" /> : <Copy size={14} />}
              <span>{copied ? "Copied" : "Copy JSON"}</span>
            </button>
            {summary && (
              <button
                className="footer-tool-btn"
                onClick={() =>
                  downloadFile(
                    `${call.brand}-conversation-recap.md`,
                    recapMarkdown(summary),
                    "text/markdown;charset=utf-8",
                  )
                }
                title="Download formatted markdown summary"
              >
                <Download size={14} />
                <span>Markdown Recap</span>
              </button>
            )}
            <button
              className="footer-tool-btn"
              onClick={() =>
                downloadFile(
                  `${call.brand}-call-transcript.txt`,
                  transcriptText(call.entries),
                  "text/plain;charset=utf-8",
                )
              }
              title="Download call transcript"
            >
              <FileText size={14} />
              <span>Transcript</span>
            </button>
          </div>

          <div className="footer-action-group">
            <button className="footer-close-btn" onClick={onClose}>
              Dismiss
            </button>
            <button
              className="footer-primary-btn"
              onClick={() => {
                onClose();
                void call.start();
              }}
            >
              <Phone size={15} />
              <span>Start New Call</span>
            </button>
          </div>
        </div>
      }
    >
      {summary && (
        <div className="summary-sheet-content">
          {/* Top Session Vitals Ribbon */}
          <div className="summary-vitals-strip">
            <div className="vital-chip">
              <Clock size={13} className="vital-icon" />
              <span className="vital-label">Duration</span>
              <strong className="vital-val">
                {summary.metrics.duration_seconds !== null
                  ? formatClock(summary.metrics.duration_seconds)
                  : "00:00"}
              </strong>
            </div>

            <div className="vital-chip">
              <MessageSquare size={13} className="vital-icon" />
              <span className="vital-label">Customer Turns</span>
              <strong className="vital-val">{summary.metrics.customer_turns}</strong>
            </div>

            <div className="vital-chip">
              <Zap size={13} className="vital-icon" />
              <span className="vital-label">Tool Calls</span>
              <strong className="vital-val">{summary.metrics.tool_calls}</strong>
            </div>

            {summary.metrics.avg_response_ms !== null && (
              <div className="vital-chip">
                <Activity size={13} className="vital-icon" />
                <span className="vital-label">Avg Response</span>
                <strong className="vital-val">
                  {formatMs(summary.metrics.avg_response_ms)}
                </strong>
              </div>
            )}
          </div>

          {/* View Mode Navigation Tabs */}
          <div className="summary-view-tabs" role="tablist">
            <button
              role="tab"
              aria-selected={tab === "overview"}
              className={`view-tab-btn ${tab === "overview" ? "active" : ""}`}
              onClick={() => setTab("overview")}
            >
              {tab === "overview" && (
                <motion.span
                  layoutId="summary-tab-pill"
                  className="view-tab-highlight"
                  transition={{ type: "spring", stiffness: 420, damping: 34 }}
                />
              )}
              <Sparkles size={14} className="relative z-10" />
              <span className="relative z-10">Executive Brief & Audit</span>
            </button>

            <button
              role="tab"
              aria-selected={tab === "json"}
              className={`view-tab-btn ${tab === "json" ? "active" : ""}`}
              onClick={() => setTab("json")}
            >
              {tab === "json" && (
                <motion.span
                  layoutId="summary-tab-pill"
                  className="view-tab-highlight"
                  transition={{ type: "spring", stiffness: 420, damping: 34 }}
                />
              )}
              <FileJson size={14} className="relative z-10" />
              <span className="relative z-10">Raw Data (JSON)</span>
            </button>
          </div>

          {/* Active Tab View */}
          {tab === "overview" ? (
            <div className="summary-tab-content">
              <Overview summary={summary} />
              <TicketList tickets={call.tickets} />
              {call.phase === "idle" && <FeedbackPrompt call={call} />}
            </div>
          ) : (
            <div className="json-container-modern">
              <div className="json-toolbar">
                <span className="json-meta-tag">Application/JSON · Signed Audit Record</span>
                <button className="json-quick-copy-btn" onClick={() => void copy()}>
                  {copied ? <Check size={13} /> : <Copy size={13} />}
                  <span>{copied ? "Copied to clipboard" : "Copy"}</span>
                </button>
              </div>
              <pre className="json json-modern" tabIndex={0}>
                {highlight(json)}
              </pre>
            </div>
          )}
        </div>
      )}
    </Sheet>
  );
}

