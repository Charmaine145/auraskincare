"use client";

import { useEffect, useRef, useState, type FormEvent } from "react";
import { AnimatePresence, motion } from "motion/react";
import { ArrowDownToLine, ArrowRight, ArrowUp, FileText, Keyboard, Mic, MicOff, PackageSearch, RotateCcw, Sparkles, XCircle } from "lucide-react";
import type { TranscriptEntry, VoiceCall } from "@/hooks/useVoiceCall";
import { brandById, sampleIds, type Brand } from "@/data/brand";
import { downloadFile, formatMs, formatTime } from "@/lib/format";
import { ActionStatus } from "./ActionStatus";
import { BlurText } from "./ui/BlurText";

function suggestionsFor(brand: Brand) {
  const ids = sampleIds(brand);
  const careType = brand.concern === "skin" ? "skincare" : "haircare";
  const recommendation = brand.concern === "skin"
    ? "Can you recommend a moisturiser for dry skin?"
    : "Can you recommend a shampoo for hair fall?";
  return [
    { id: "suggestion-track", icon: PackageSearch, title: "Track a shipment", prompt: `Can you check the status of order ${ids.track}?` },
    { id: "suggestion-return", icon: RotateCcw, title: "Understand return eligibility", prompt: `Am I eligible to return order ${ids.returnable}?` },
    { id: "suggestion-cancel", icon: XCircle, title: "Request order cancellation", prompt: `I'd like to cancel order ${ids.cancellable}.` },
    { id: "suggestion-products", icon: Sparkles, title: `Get ${careType} product recommendations`, prompt: recommendation },
  ];
}

export function scenariosFor(brand: Brand) {
  const ids = sampleIds(brand);
  return [
    `Where is my order ${ids.track}?`,
    `Can I return ${ids.returnable}?`,
    `Please cancel my order ${ids.cancellable}.`,
    "I bought this 20 days ago and have opened it. Can I return it?",
    "Where is my order ORD-999?",
    `Can you cancel ${ids.track}?`,
    "Is Cash on Delivery available?",
    brand.concern === "skin"
      ? "Can you recommend a moisturiser for dry skin?"
      : "Can you recommend a shampoo for hair fall?",
    `My order ${ids.damaged} arrived damaged and I have photos.`,
    "I want to speak to a real person.",
    "Can you book me a flight to Goa?",
    `Mera order ${ids.track} kab tak aayega?`,
    "Can I talk to a real person?",
  ];
}

export function transcriptText(entries: TranscriptEntry[]): string {
  return entries
    .map(e => `[${new Date(e.timestamp).toLocaleTimeString("en-IN")}] ${e.role === "user" ? "Customer" : "Aria"}: ${e.content}${e.interrupted ? " [interrupted]" : ""}`)
    .join("\n\n");
}

function Message({ entry, animate }: { entry: TranscriptEntry; animate: boolean }) {
  const aria = entry.role === "assistant";
  const tools = [...new Set(entry.tools ?? [])];
  return (
    <motion.div
      className={`msg ${aria ? "aria" : "user"}`}
      initial={{ opacity: 0, y: 10 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ type: "spring", stiffness: 380, damping: 32 }}
    >
      <div className="msg-text">{aria && animate ? <BlurText text={entry.content} /> : entry.content}</div>
      <div className="msg-meta">
        <time dateTime={entry.timestamp}>{formatTime(entry.timestamp)}</time>
        {entry.via === "voice" && <Mic size={11} aria-label="spoken" />}
        {entry.via === "text" && <Keyboard size={11} aria-label="typed" />}
        {entry.latencyMs !== undefined && <span title="From the end of your turn to Aria's first word">{formatMs(entry.latencyMs)}</span>}
        {tools.map(tool => (
          <span key={tool} className="meta-tool">{tool}</span>
        ))}
        {entry.source === "policy" && <span className="meta-policy">policy</span>}
        {entry.source === "direct" && <span className="meta-policy" title="Answered from the verified order record, without a model call">instant</span>}
        {entry.interrupted && <span>interrupted</span>}
      </div>
    </motion.div>
  );
}

function withSolidIds(text: string) {
  return text.split(/(ORD-\d{3})/g).map((part, i) =>
    /^ORD-\d{3}$/.test(part) ? <span key={i} className="nowrap">{part}</span> : part,
  );
}

export function Conversation({ call, onShowSummary }: { call: VoiceCall; onShowSummary: () => void }) {
  const [draft, setDraft] = useState("");
  const [menuOpen, setMenuOpen] = useState(false);
  const scroller = useRef<HTMLDivElement>(null);
  const live = call.phase === "live";
  const thinking = live && call.agentState === "Thinking";
  const busy = !call.config || call.phase === "starting" || call.phase === "ending" || thinking;
  const connection = call.phase === "live"
    ? "Online"
    : call.phase === "starting" || call.phase === "ending"
      ? "Connecting"
      : call.problem
        ? "Connection issue"
        : call.config
          ? "Ready"
          : "Connecting";
  const engine = !call.config ? "Loading assistant…" : call.config.mode === "demo" ? "Rule-based demo" : call.config.modelLabel;
  const careType = brandById(call.brand).concern === "skin" ? "skincare" : "haircare";

  useEffect(() => {
    const element = scroller.current;
    // The empty state is taller than the panel on short screens; scrolling it on mount would hide its heading.
    if (!element || (call.entries.length === 0 && !call.interim && !thinking)) return;
    element.scrollTo({ top: element.scrollHeight, behavior: "smooth" });
  }, [call.entries, call.interim, thinking]);

  const send = (text: string) => {
    if (!text.trim() || busy) return;
    call.ask(text);
    setDraft("");
    setMenuOpen(false);
  };
  const submit = (event: FormEvent) => {
    event.preventDefault();
    send(draft);
  };

  return (
    <section className="conversation" aria-label="Chat with Aria">
      <header className="conversation-head">
        <div className="conversation-heading">
          <span className="conversation-title">Chat with Aria</span>
          <span className="conversation-engine">{engine}</span>
        </div>
        <div className="conversation-actions">
          <span className={`connection-status ${call.phase === "live" ? "online" : call.problem ? "problem" : ""}`} role="status">
            <span className="connection-dot" />{connection}
          </span>
          {call.summary && call.phase === "idle" && (
            <button className="chip-btn labelled" onClick={onShowSummary}>
              <FileText size={14} /> Summary
            </button>
          )}
          <button className="icon-btn" disabled={!call.entries.length} onClick={() => downloadFile(`${call.brand}-call-transcript.txt`, transcriptText(call.entries), "text/plain;charset=utf-8")} aria-label="Download transcript" title="Download transcript">
            <ArrowDownToLine size={16} />
          </button>
        </div>
      </header>

      <div className="transcript" ref={scroller} role="log" aria-live="polite" aria-relevant="additions">
        <div className="welcome-banner" id="welcome-banner">
          <span className="welcome-mark"><Sparkles size={17} aria-hidden /></span>
          <p>You can ask me about your orders, returns, payments, or get {careType} product guidance.</p>
        </div>
        {call.entries.length === 0 ? (
          <div className="empty">
            <motion.h2 initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: 0.15 }}>
              Try a suggested question
            </motion.h2>
            <div className="suggestions">
              {suggestionsFor(brandById(call.brand)).map(({ id, icon: Icon, title, prompt }, i) => (
                <motion.button
                  id={id}
                  key={title}
                  className="suggestion"
                  onClick={() => send(prompt)}
                  disabled={busy}
                  initial={{ opacity: 0, y: 12 }}
                  animate={{ opacity: 1, y: 0 }}
                  transition={{ delay: 0.2 + i * 0.06 }}
                  whileHover={{ y: -2 }}
                >
                  <span className="suggestion-icon"><Icon size={18} aria-hidden /></span>
                  <span className="suggestion-title">{title}</span>
                  <span className="suggestion-prompt">“{withSolidIds(prompt)}”</span>
                  <span className="suggestion-arrow" aria-hidden><ArrowRight size={16} /></span>
                </motion.button>
              ))}
            </div>
          </div>
        ) : (
          // Motion animates on mount only, so each reply gets its word-by-word entrance exactly once.
          call.entries.map(entry => <Message key={entry.id} entry={entry} animate={live} />)
        )}
        <AnimatePresence>
          {call.interim && (
            <motion.div className="msg user interim" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}>
              <div className="msg-text">{call.interim}</div>
            </motion.div>
          )}
          {thinking && (
            <motion.div className="thinking" initial={{ opacity: 0, y: 6 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0 }}>
              <span className="dots"><i /><i /><i /></span>
              <span className="shiny">{call.statusLabel || "Thinking"}</span>
            </motion.div>
          )}
        </AnimatePresence>
      </div>

      <ActionStatus actions={call.actions} />

      <form className="composer" onSubmit={submit}>
        <div className="try-anchor">
          <button type="button" className="icon-btn" onClick={() => setMenuOpen(open => !open)} aria-label="Test scenarios" aria-expanded={menuOpen} title="Test scenarios" disabled={busy}>
            <Sparkles size={16} />
          </button>
          <AnimatePresence>
            {menuOpen && (
              <motion.ul className="scenario-menu" initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: 6 }} transition={{ duration: 0.16 }}>
                <li className="scenario-menu-title">Test scenarios</li>
                {scenariosFor(brandById(call.brand)).map(prompt => (
                  <li key={prompt}>
                    <button type="button" onClick={() => send(prompt)}>{prompt}</button>
                  </li>
                ))}
              </motion.ul>
            )}
          </AnimatePresence>
        </div>
        <input
          aria-label="Message Aria"
          placeholder={live ? "Type a message…" : "Enter your message to begin chatting…"}
          value={draft}
          maxLength={2000}
          onChange={e => setDraft(e.target.value)}
          disabled={busy}
        />
        <button type="submit" className="send-btn" aria-label="Send" disabled={!draft.trim() || busy}>
          <ArrowUp size={17} />
        </button>
        {(call.phase === "idle" || (live && !call.textMode)) && (
          <button
            type="button"
            className={`composer-mic ${live && call.muted ? "muted" : ""}`}
            aria-label={live ? call.muted ? "Unmute microphone" : "Mute microphone" : "Start voice call"}
            title={live ? call.muted ? "Unmute microphone" : "Mute microphone" : "Start voice call"}
            disabled={!call.config || call.phase === "starting" || call.phase === "ending"}
            onClick={() => live ? call.toggleMute() : void call.start()}
          >
            {live && call.muted ? <MicOff size={17} /> : <Mic size={17} />}
          </button>
        )}
      </form>
    </section>
  );
}
