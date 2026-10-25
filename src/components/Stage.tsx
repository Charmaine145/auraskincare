"use client";

import { useEffect, useRef, useState } from "react";
import { AnimatePresence, motion } from "motion/react";
import { Clock3, Hand, LoaderCircle, MessageSquare, Mic, MicOff, PhoneOff, Play, Settings2, ShieldCheck, Square, Zap } from "lucide-react";
import type { VoiceCall } from "@/hooks/useVoiceCall";
import { formatClock } from "@/lib/format";
import { useBrowserVoices } from "@/hooks/useBrowserVoices";
import { EDGE_TIP, isEdge, isNaturalVoice } from "@/lib/voice/browserVoices";
import type { OrbProblem } from "@/lib/voice/orbState";
import { brandById } from "@/data/brand";
import { VoiceMeter } from "./ui/VoiceMeter";

const PROBLEM_STATUS: Record<Exclude<OrbProblem, null>, { title: string; detail: string }> = {
  microphone: { title: "Microphone unavailable", detail: "Allow microphone access from the address bar, or continue by text." },
  speech: { title: "Speech unavailable", detail: "Aria couldn't hear or speak just now. You can type your reply." },
  connection: { title: "Connection problem", detail: "Aria couldn't reach the server. Please try again." },
};

function status(call: VoiceCall): { title: string; detail: string; tone: string } {
  const concern = brandById(call.brand).concern;
  if (call.phase === "starting") return { title: "Connecting", detail: "Allow microphone access to begin", tone: "idle" };
  if (call.phase === "ending") return { title: "Wrapping up", detail: "Writing your call summary", tone: "thinking" };
  if (call.problem) return { ...PROBLEM_STATUS[call.problem], tone: "error" };
  if (call.phase !== "live" && call.ended) return {
    title: "Call ended",
    detail: "Your call summary is ready. Start a new call whenever you like, or carry on by text.",
    tone: "idle",
  };
  if (call.phase !== "live") return {
    title: `Your ${concern}care support starts here`,
    detail: `Connect with Aria for quick, convenient assistance with your orders and ${concern}care-related service queries.`,
    tone: "idle",
  };
  if (call.interrupted && call.agentState === "Listening") {
    return { title: "Interrupted", detail: call.textMode ? "Aria stopped. Type your message." : "Aria stopped. Go ahead, I'm listening.", tone: "interrupted" };
  }
  switch (call.agentState) {
    case "Listening":
      return { title: "Listening", detail: call.textMode ? "Type your message" : call.muted ? "Microphone is muted" : "Go ahead, I'm listening", tone: "listening" };
    case "Thinking":
      return { title: "Thinking", detail: call.statusLabel || "One moment", tone: "thinking" };
    case "Speaking":
      return { title: "Speaking", detail: call.bargeIn && !call.textMode ? "Talk anytime to interrupt" : "", tone: "speaking" };
    default:
      return { title: "Connecting", detail: "", tone: "idle" };
  }
}

function Settings({ call, onClose }: { call: VoiceCall; onClose: () => void }) {
  const ref = useRef<HTMLDivElement>(null);
  const idle = call.phase === "idle";
  const report = useBrowserVoices();
  const chosen = report.find(r => r.code === call.language);
  const premium = Boolean(call.config?.voiceProvider);
  // The server's natural voice for this language, if Aria will use one (Edge, Azure or Sarvam).
  const serverVoice = premium && call.voice !== "browser"
    ? call.language === "en-IN" ? call.config?.voices.find(v => v.id === call.voice)?.label : call.config?.voiceLanguages?.[call.language]
    : undefined;
  const [inEdge, setInEdge] = useState(true);
  useEffect(() => setInEdge(isEdge()), []);

  useEffect(() => {
    const onPointer = (event: PointerEvent) => {
      if (ref.current && !ref.current.contains(event.target as Node) && !(event.target as HTMLElement).closest(".settings-trigger")) onClose();
    };
    const onKey = (event: KeyboardEvent) => event.key === "Escape" && onClose();
    document.addEventListener("pointerdown", onPointer);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("pointerdown", onPointer);
      document.removeEventListener("keydown", onKey);
    };
  }, [onClose]);

  return (
    <motion.div
      ref={ref}
      className="popover"
      role="dialog"
      aria-label="Language and voice settings"
      initial={{ opacity: 0, y: 8, scale: 0.97 }}
      animate={{ opacity: 1, y: 0, scale: 1 }}
      exit={{ opacity: 0, y: 6, scale: 0.98 }}
      transition={{ duration: 0.18 }}
    >
      <label className="field">
        <span>Language</span>
        <div className="field-row">
          <select className="select" value={call.language} disabled={!idle} onChange={e => call.setLanguage(e.target.value)}>
            {report.map(r => (
              <option key={r.code} value={r.code}>{r.code === "en-IN" ? r.native : `${r.native} · ${r.label}`}</option>
            ))}
          </select>
          <button className="chip-btn" onClick={() => void call.previewVoice()} disabled={!idle} aria-label={call.previewing ? "Stop preview" : "Hear Aria in this language"}>
            {call.previewing ? <Square size={13} /> : <Play size={13} />}
          </button>
        </div>
        {serverVoice ? (
          <small>Natural voice: {serverVoice}</small>
        ) : (
          <small className={chosen?.voice ? "" : "warn-text"}>
            {chosen?.voice ? `Voice on this device: ${chosen.voice}` : `No ${chosen?.label} voice installed on this device.`}
            {!inEdge && !(chosen?.voice && isNaturalVoice(chosen.voice)) && <> {EDGE_TIP}</>}
          </small>
        )}
      </label>
      {premium && (
        <label className="field">
          <span>Aria&apos;s voice</span>
          <select className="select" value={call.voice} disabled={!idle} onChange={e => call.setVoice(e.target.value)}>
            {call.config?.voices.map(v => (
              <option key={v.id} value={v.id}>{`${v.label} · ${v.description}`}</option>
            ))}
            <option value="browser">This device&apos;s voice</option>
          </select>
        </label>
      )}
      <label className="field">
        <span>Speech recognition</span>
        <select className="select" value={call.inputEngine} disabled={!idle} onChange={e => call.setInputEngine(e.target.value as "auto" | "gemini")}>
          <option value="auto">Browser · fastest</option>
          <option value="gemini" disabled={!call.config?.cloudTranscription}>Gemini · any browser</option>
        </select>
      </label>
      <label className="toggle">
        <input type="checkbox" checked={call.bargeIn} onChange={e => call.setBargeIn(e.target.checked)} />
        <span className="toggle-track" aria-hidden />
        <span>
          Interrupt by speaking
          <small>Turn off on loudspeakers if Aria stops by herself.</small>
        </span>
      </label>
      <details className="voice-list">
        <summary>Voices on this device</summary>
        <ul>
          {report.map(r => (
            <li key={r.code} className={r.voice ? "" : "missing"}>
              <span>{r.label}</span>
              <span>{r.voice ?? "not installed"}</span>
            </li>
          ))}
        </ul>
      </details>
    </motion.div>
  );
}

export function Stage({ call }: { call: VoiceCall }) {
  const [settingsOpen, setSettingsOpen] = useState(false);
  const { phase } = call;
  const live = phase === "live";
  const current = status(call);
  const careType = brandById(call.brand).concern === "skin" ? "skincare" : "haircare";
  const settingsControl = (
    <div className="settings-anchor">
      <button className="round-btn settings-trigger" onClick={() => setSettingsOpen(open => !open)} aria-label="Voice settings" aria-expanded={settingsOpen} title="Voice settings">
        <Settings2 size={18} />
      </button>
      <AnimatePresence>{settingsOpen && <Settings call={call} onClose={() => setSettingsOpen(false)} />}</AnimatePresence>
    </div>
  );

  return (
    <section className="stage" data-phase={phase} aria-label="Aria introduction and voice call">
      <div className="identity">
        <h1>Hi there,<br />I&apos;m <span>Aria</span></h1>
        <p>Your personal AI assistant for orders, returns, payments and all your {careType} questions.</p>
      </div>

      <div className="hero-sparkle" aria-hidden="true">
        <svg viewBox="0 0 40 40" focusable="false">
          <defs>
            <linearGradient id="aria-sparkle-gradient" x1="6" y1="5" x2="34" y2="35" gradientUnits="userSpaceOnUse">
              <stop stopColor="#fff" />
              <stop offset="1" stopColor="#b99ae9" />
            </linearGradient>
          </defs>
          <path d="M20 3.5 23.6 16.4 36.5 20 23.6 23.6 20 36.5 16.4 23.6 3.5 20 16.4 16.4 20 3.5Z" fill="url(#aria-sparkle-gradient)" />
        </svg>
      </div>

      <ul className="intro-features" aria-label="Assistant features">
        <li><span><Zap size={16} /></span>Quick answers</li>
        <li><span><ShieldCheck size={16} /></span>Secure &amp; private</li>
        <li><span><Clock3 size={16} /></span>24/7 support</li>
      </ul>

      <div className="status" role="status" aria-live="polite" data-tone={current.tone}>
        <AnimatePresence mode="wait" initial={false}>
          <motion.div
            key={`${current.title}|${current.detail}`}
            className="status-inner"
            initial={{ opacity: 0, y: 6, filter: "blur(4px)" }}
            animate={{ opacity: 1, y: 0, filter: "blur(0px)" }}
            exit={{ opacity: 0, y: -6, filter: "blur(4px)" }}
            transition={{ duration: 0.22 }}
          >
            <span className="status-title">
              <span className="status-dot" />
              {current.title}
              {live && <span className="status-clock">{formatClock(call.elapsed)}</span>}
              {live && <VoiceMeter analyser={call.agentState === "Speaking" ? call.outputAnalyser : call.micAnalyser} state={call.agentState} muted={call.muted} />}
            </span>
            {current.detail && <span className={`status-detail ${current.tone === "thinking" ? "shiny" : ""}`}>{current.detail}</span>}
          </motion.div>
        </AnimatePresence>
      </div>

      {phase === "idle" && <span className="demo-pill">{call.ended ? "Demo complete" : "Try the Interactive Demo"}</span>}

      <div className="controls">
        {phase === "idle" && (
          <div className="intro-actions">
            {settingsControl}
            <motion.button className="start-btn" onClick={() => void call.start()} disabled={!call.config} whileHover={{ scale: 1.02 }} whileTap={{ scale: 0.97 }}>
              <span className="start-glow" aria-hidden />
              <Mic size={19} /> {call.ended ? "Start New Call" : "Start Voice Call"}
            </motion.button>
            <button className="text-btn" onClick={() => void call.start({ text: true })} disabled={!call.config}>
              <MessageSquare size={17} /> Chat with Aria
            </button>
          </div>
        )}
        {phase === "starting" && (
          <button className="pill-btn ghost" onClick={() => void call.end()}>
            <LoaderCircle size={17} className="spin" /> Cancel
          </button>
        )}
        {live && (
          <>
            {!call.textMode && (
              <button className={`round-btn ${call.muted ? "danger-soft" : ""}`} onClick={call.toggleMute} aria-label={call.muted ? "Unmute" : "Mute"} aria-pressed={call.muted} title={call.muted ? "Unmute" : "Mute"}>
                {call.muted ? <MicOff size={19} /> : <Mic size={19} />}
              </button>
            )}
            <motion.button className="pill-btn danger" onClick={() => void call.end()} whileTap={{ scale: 0.96 }}>
              <PhoneOff size={18} /> End
            </motion.button>
            <AnimatePresence>
              {call.agentState === "Speaking" && (
                <motion.button
                  className="round-btn"
                  onClick={call.interrupt}
                  aria-label="Interrupt Aria"
                  title="Interrupt"
                  initial={{ opacity: 0, scale: 0.7 }}
                  animate={{ opacity: 1, scale: 1 }}
                  exit={{ opacity: 0, scale: 0.7 }}
                >
                  <Hand size={19} />
                </motion.button>
              )}
            </AnimatePresence>
          </>
        )}
        {phase === "ending" && (
          <button className="pill-btn ghost" disabled>
            <LoaderCircle size={17} className="spin" /> Wrapping up
          </button>
        )}
        {phase !== "idle" && settingsControl}
      </div>

    </section>
  );
}
