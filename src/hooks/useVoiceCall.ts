"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { readNdjson } from "@/lib/ndjson";
import { commitDelay, createRecognition, type Recognition } from "@/lib/voice/recognition";
import { VOICE_PROVIDER_LABEL, type ClipName } from "@/lib/voice/options";
import { greetingFor, languageByCode, LANGUAGES, silenceLine } from "@/lib/voice/languages";
import { DEFAULT_BRAND, isBrandId, type BrandId } from "@/data/brand";
import { EDGE_TIP, isEdge, isNaturalVoice, pickVoice } from "@/lib/voice/browserVoices";
import { VoicePlayer, type VoiceEngine } from "@/lib/voice/player";
import type { OrbProblem } from "@/lib/voice/orbState";
import { analyserRms, VoiceActivityDetector, type VadMode } from "@/lib/voice/vad";
import {
  applyActionResult,
  markActionUnresolved,
  markTurnUnresolved,
  reconcileCancelled,
  recordAction,
  startAction,
  supersedeConfirmations,
  type ActionRecord,
} from "@/lib/agent/actionState";
import type { AgentState, AppConfig, CallSummary, ChatStreamEvent, ReplySource, TicketView, ToolName, ToolStatus } from "@/types";

/**
 * The call engine. Owns the microphone, speech recognition, the agent request, Aria's voice,
 * barge-in, the live activity log and latency metrics. Components only render its state.
 *
 * Async work (network, audio, recognizer callbacks) can finish after the call has moved on,
 * so every callback checks a generation counter before touching state:
 *   - `epoch` changes when a call starts or ends,
 *   - `speechEpoch` changes whenever Aria is stopped or starts a new line.
 */

export type CallPhase = "idle" | "starting" | "live" | "ending";
/** A premium voice id from /api/config, or the browser's built-in voice. */
export type VoiceChoice = string;
export type InputEngine = "auto" | "gemini";

export interface TranscriptEntry {
  id: string;
  role: "user" | "assistant";
  content: string;
  timestamp: string;
  via?: "voice" | "text";
  interrupted?: boolean;
  /** Customer finished speaking -> Aria's voice started. */
  latencyMs?: number;
  tools?: ToolName[];
  source?: ReplySource | "greeting" | "check-in";
}

export interface ActivityItem {
  id: string;
  turn: number;
  at: number;
  kind: "system" | "heard" | "tool" | "guardrail" | "model" | "voice" | "error";
  title: string;
  detail?: string;
  status?: "running" | "ok" | "warn" | "error";
  ms?: number;
}

export interface Notice {
  tone: "info" | "warning" | "error";
  text: string;
}

const MAX_CUSTOMER_TURNS = 60;
/** Silence while Aria listens before she checks in, and then before she says goodbye. */
const SILENCE_CHECK_MS = 12_000;
const SILENCE_GOODBYE_MS = 10_000;
/** A tool call should be answered in the same stream tick; longer means the stream stalled. */
const ACTION_TIMEOUT_MS = 15_000;
/** Never leave a turn spinning forever; nothing is retried automatically. */
const REQUEST_TIMEOUT_MS = 45_000;
const uid = () => crypto.randomUUID();

const TOOL_STATUS: Record<ToolStatus, ActivityItem["status"]> = {
  ok: "ok", done: "ok", confirm: "ok", needs_info: "warn", not_found: "warn", declined: "warn", blocked: "error", error: "error",
};

function thinkingLabel(name: ToolName, args: Record<string, unknown>): string {
  const id = typeof args.order_id === "string" ? args.order_id.toUpperCase() : "";
  switch (name) {
    case "get_order_details": return id ? `Looking up ${id}` : "Looking up your order";
    case "cancel_order": return "Checking the cancellation policy";
    case "check_return_eligibility": return "Checking the return policy";
    case "escalate_to_human": return "Creating a demo ticket";
    case "find_products": return "Checking the product catalogue";
    default: return "Working on it";
  }
}

const formatArgs = (args: Record<string, unknown>) =>
  Object.entries(args).map(([key, value]) => `${key}: ${JSON.stringify(value)}`).join(", ");

export function useVoiceCall() {
  const [config, setConfig] = useState<AppConfig | null>(null);
  const [phase, setPhaseState] = useState<CallPhase>("idle");
  const [agentState, setAgentStateValue] = useState<AgentState>("Idle");
  const [statusLabel, setStatusLabel] = useState("");
  const [muted, setMuted] = useState(false);
  const [textMode, setTextMode] = useState(false);
  const [speechPath, setSpeechPath] = useState<"browser" | "gemini" | null>(null);
  const [entries, setEntries] = useState<TranscriptEntry[]>([]);
  const [interim, setInterim] = useState("");
  const [activity, setActivity] = useState<ActivityItem[]>([]);
  /** Tool-backed actions, derived only from server events (never from Aria's wording). */
  const [actions, setActions] = useState<ActionRecord[]>([]);
  const [notice, setNotice] = useState<Notice | null>(null);
  const [summary, setSummary] = useState<CallSummary | null>(null);
  const [tickets, setTickets] = useState<TicketView[]>([]);
  const [ended, setEnded] = useState(false);
  const [cancelled, setCancelled] = useState<string[]>([]);
  const [elapsed, setElapsed] = useState(0);
  const [micAnalyser, setMicAnalyser] = useState<AnalyserNode | null>(null);
  const [voice, setVoiceState] = useState<VoiceChoice>("browser");
  const [inputEngine, setInputEngine] = useState<InputEngine>("auto");
  const [language, setLanguageState] = useState("en-IN");
  const [bargeIn, setBargeInState] = useState(true);
  const [previewing, setPreviewing] = useState(false);
  const [latencies, setLatencies] = useState<number[]>([]);
  /** True briefly after a barge-in, so the orb can show the interruption without faking it. */
  const [interrupted, setInterrupted] = useState(false);
  /** A real failure (mic, speech, connection); auto-clears while the notice stays visible. */
  const [problem, setProblemState] = useState<OrbProblem>(null);

  const configRef = useRef<AppConfig | null>(null);
  const phaseRef = useRef<CallPhase>("idle");
  const stateRef = useRef<AgentState>("Idle");
  const mutedRef = useRef(false);
  const textModeRef = useRef(false);
  const bargeInRef = useRef(true);
  const voiceRef = useRef<VoiceChoice>("browser");
  const languageRef = useRef("en-IN");
  const [brand, setBrandState] = useState<BrandId>(DEFAULT_BRAND);
  const brandRef = useRef<BrandId>(DEFAULT_BRAND);
  const speechPathRef = useRef<"browser" | "gemini" | null>(null);
  const epoch = useRef(0);
  const speechEpoch = useRef(0);
  const previewEpoch = useRef(0);
  const sessionToken = useRef<string | undefined>(undefined);
  const transcript = useRef<TranscriptEntry[]>([]);
  const turn = useRef(0);
  const callStartedAt = useRef(0);
  const lastSpeechAt = useRef(0);
  /** How many times Aria has checked on a silent caller since they last spoke. */
  const silenceChecks = useRef(0);
  const voiceDegraded = useRef(false);
  const endAfterSpeaking = useRef(false);
  const latencyLog = useRef<number[]>([]);

  const playerRef = useRef<VoicePlayer | null>(null);
  const recognition = useRef<Recognition | null>(null);
  const stream = useRef<MediaStream | null>(null);
  const micSource = useRef<MediaStreamAudioSourceNode | null>(null);
  const recorder = useRef<MediaRecorder | null>(null);
  const captured = useRef<Blob[]>([]);
  const keepCapture = useRef(false);
  const vad = useRef(new VoiceActivityDetector());
  const vadFrame = useRef(0);
  const request = useRef<AbortController | null>(null);
  const transcribeRequest = useRef<AbortController | null>(null);
  const restartTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const commitTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  /** Per-action watchdogs, so a stalled stream can never leave a call looking pending forever. */
  const actionTimers = useRef(new Map<string, ReturnType<typeof setTimeout>>());
  const interruptedTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const problemTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const finalBuffer = useRef("");
  const submitRef = useRef<(text: string, via: "voice" | "text") => Promise<void>>(async () => {});
  const endRef = useRef<() => Promise<void>>(async () => {});

  const player = useCallback(() => (playerRef.current ??= new VoicePlayer()), []);
  const alive = useCallback((generation: number) => phaseRef.current === "live" && generation === epoch.current, []);

  // ------------------------------------------------------------------ small state helpers

  const setPhase = useCallback((value: CallPhase) => {
    phaseRef.current = value;
    setPhaseState(value);
  }, []);

  const setAgentState = useCallback((value: AgentState, label = "") => {
    stateRef.current = value;
    setAgentStateValue(value);
    setStatusLabel(label);
  }, []);

  /** Shows the interruption cue for a moment; a newer request's processing state overrides it. */
  const flashInterrupted = useCallback(() => {
    if (interruptedTimer.current) clearTimeout(interruptedTimer.current);
    setInterrupted(true);
    interruptedTimer.current = setTimeout(() => {
      interruptedTimer.current = null;
      setInterrupted(false);
    }, 1500);
  }, []);

  const clearInterrupted = useCallback(() => {
    if (interruptedTimer.current) clearTimeout(interruptedTimer.current);
    interruptedTimer.current = null;
    setInterrupted(false);
  }, []);

  /** Surfaces a genuine failure on the orb; the explanatory notice is not auto-cleared. */
  const reportProblem = useCallback((kind: Exclude<OrbProblem, null>) => {
    if (problemTimer.current) clearTimeout(problemTimer.current);
    setProblemState(kind);
    problemTimer.current = setTimeout(() => {
      problemTimer.current = null;
      setProblemState(null);
    }, 6000);
  }, []);

  const clearProblem = useCallback(() => {
    if (problemTimer.current) clearTimeout(problemTimer.current);
    problemTimer.current = null;
    setProblemState(null);
  }, []);

  const addEntry = useCallback((entry: Omit<TranscriptEntry, "id" | "timestamp">) => {
    const full: TranscriptEntry = { ...entry, id: uid(), timestamp: new Date().toISOString() };
    transcript.current = [...transcript.current, full];
    setEntries(transcript.current);
    return full.id;
  }, []);

  const updateEntry = useCallback((id: string, patch: Partial<TranscriptEntry>) => {
    transcript.current = transcript.current.map(e => (e.id === id ? { ...e, ...patch } : e));
    setEntries(transcript.current);
  }, []);

  const markInterrupted = useCallback(() => {
    const last = transcript.current.at(-1);
    if (last?.role === "assistant") updateEntry(last.id, { interrupted: true });
  }, [updateEntry]);

  const log = useCallback((item: Omit<ActivityItem, "id" | "at" | "turn"> & { id?: string }) => {
    const entry: ActivityItem = { id: uid(), turn: turn.current, at: callStartedAt.current ? Date.now() - callStartedAt.current : 0, ...item };
    setActivity(items => [...items, entry].slice(-150));
    return entry.id;
  }, []);

  const updateLog = useCallback((id: string, patch: Partial<ActivityItem>) => {
    setActivity(items => items.map(item => (item.id === id ? { ...item, ...patch } : item)));
  }, []);

  const clearActionTimer = useCallback((id: string) => {
    const timer = actionTimers.current.get(id);
    if (timer) clearTimeout(timer);
    actionTimers.current.delete(id);
  }, []);

  const clearActionTimers = useCallback(() => {
    for (const timer of actionTimers.current.values()) clearTimeout(timer);
    actionTimers.current.clear();
  }, []);

  const warnOnce = useRef(new Set<string>());
  const noticeOnce = useCallback((text: string, tone: Notice["tone"] = "warning") => {
    if (warnOnce.current.has(text)) return;
    warnOnce.current.add(text);
    setNotice({ tone, text });
  }, []);

  const engine = useCallback((): VoiceEngine => {
    if (voiceRef.current === "browser" || voiceDegraded.current || !configRef.current?.voiceProvider) return "browser";
    return "premium";
  }, []);
  const voiceName = (): string | undefined => (voiceRef.current === "browser" ? undefined : voiceRef.current);
  // The picker holds an English voice; other languages are read by that language's own voice.
  const spokenVoiceLabel = () =>
    (languageRef.current === "en-IN" ? configRef.current?.voices.find(v => v.id === voiceName())?.label : configRef.current?.voiceLanguages?.[languageRef.current]) ?? "voice";
  const clip = (name: ClipName, onStart?: () => void) => player().playClip(configRef.current?.voiceProvider ?? null, voiceName(), name, onStart, brandRef.current);

  // ------------------------------------------------------------------ listening

  const clearCommit = () => {
    if (commitTimer.current) clearTimeout(commitTimer.current);
    commitTimer.current = null;
    finalBuffer.current = "";
  };

  const discardCapture = useCallback(() => {
    keepCapture.current = false;
    const current = recorder.current;
    recorder.current = null;
    captured.current = [];
    if (current?.state === "recording") current.stop();
    vad.current.reset();
  }, []);

  /** Stops all listening while Aria thinks or speaks, so her own voice isn't transcribed. */
  const pauseListening = useCallback(() => {
    recognition.current?.abort();
    discardCapture();
    clearCommit();
    setInterim("");
  }, [discardCapture]);

  /** Server-transcription path: record one utterance, cut by the voice-activity detector. */
  const startCapture = useCallback(() => {
    if (!stream.current || recorder.current || phaseRef.current !== "live" || mutedRef.current || stateRef.current !== "Listening") return;
    const mimeType = ["audio/webm;codecs=opus", "audio/webm", "audio/ogg;codecs=opus", "audio/mp4"].find(type => MediaRecorder.isTypeSupported(type));
    if (!mimeType) {
      textModeRef.current = true;
      setTextMode(true);
      reportProblem("speech");
      setNotice({ tone: "warning", text: "This browser can't record audio for transcription. Please type your questions instead." });
      return;
    }
    const current = new MediaRecorder(stream.current, { mimeType });
    recorder.current = current;
    captured.current = [];
    keepCapture.current = false;
    current.ondataavailable = event => {
      if (event.data.size) captured.current.push(event.data);
    };
    current.onstop = async () => {
      if (recorder.current !== current) return;
      recorder.current = null;
      const chunks = captured.current;
      captured.current = [];
      if (!keepCapture.current || phaseRef.current !== "live" || stateRef.current !== "Listening") return;
      keepCapture.current = false;
      const generation = epoch.current;
      lastSpeechAt.current = performance.now();
      setAgentState("Thinking", "Transcribing");
      setInterim("Transcribing…");
      const controller = new AbortController();
      transcribeRequest.current = controller;
      try {
        const form = new FormData();
        form.append("audio", new Blob(chunks, { type: mimeType.split(";")[0] }), "question.webm");
        const response = await fetch("/api/transcribe", { method: "POST", body: form, signal: controller.signal });
        const data = await response.json();
        if (!response.ok) throw new Error(data.error || "I couldn't hear that clearly.");
        if (!alive(generation)) return;
        setInterim("");
        setAgentState("Listening");
        void submitRef.current(data.text, "voice");
      } catch (error) {
        if (!alive(generation) || controller.signal.aborted) return;
        setInterim("");
        reportProblem("speech");
        setNotice({ tone: "info", text: error instanceof Error ? error.message : "I couldn't hear that clearly. Please repeat." });
        setAgentState("Listening");
        startCapture();
      }
    };
    current.start(250);
  }, [alive, reportProblem, setAgentState]);

  const listen = useCallback(() => {
    if (phaseRef.current !== "live" || mutedRef.current || textModeRef.current || stateRef.current !== "Listening") return;
    if (speechPathRef.current === "gemini") {
      startCapture();
      return;
    }
    try {
      recognition.current?.start();
    } catch {
      // Already running.
    }
  }, [startCapture]);

  const handleBargeIn = useCallback(() => {
    speechEpoch.current++;
    endAfterSpeaking.current = false;
    markInterrupted();
    player().stop();
    flashInterrupted();
    setAgentState("Listening");
    log({ kind: "voice", title: "Barge-in", detail: "You started talking, so Aria stopped and listened.", status: "ok" });
    listen();
  }, [flashInterrupted, listen, log, markInterrupted, player, setAgentState]);

  const runVad = useCallback((analyser: AnalyserNode) => {
    const data = new Uint8Array(analyser.fftSize);
    let outputData = new Uint8Array(256);
    const tick = () => {
      if (phaseRef.current !== "live") return;
      const now = performance.now();
      const mode: VadMode = mutedRef.current
        ? "idle"
        : stateRef.current === "Speaking" && bargeInRef.current
          ? "speaking"
          : stateRef.current === "Listening" && recorder.current?.state === "recording"
            ? "recording"
            : "idle";
      // Aria's own output level lets the detector tell her echo from the caller's voice.
      const output = player().analyser;
      if (output && outputData.length !== output.fftSize) outputData = new Uint8Array(output.fftSize);
      const outputRms = mode === "speaking" && output ? analyserRms(output, outputData) : 0;
      const event = vad.current.update(mode, analyserRms(analyser, data), now, outputRms);
      if (event === "interrupt") handleBargeIn();
      if (event === "utterance_end" && recorder.current?.state === "recording") {
        keepCapture.current = true;
        recorder.current.stop();
      }
      vadFrame.current = requestAnimationFrame(tick);
    };
    vadFrame.current = requestAnimationFrame(tick);
  }, [handleBargeIn, player]);

  const teardownAudio = useCallback(() => {
    cancelAnimationFrame(vadFrame.current);
    if (restartTimer.current) clearTimeout(restartTimer.current);
    restartTimer.current = null;
    clearCommit();
    const rec = recognition.current;
    recognition.current = null;
    if (rec) {
      rec.onresult = rec.onerror = null;
      rec.onend = null;
      rec.abort();
    }
    discardCapture();
    stream.current?.getTracks().forEach(track => track.stop());
    stream.current = null;
    micSource.current?.disconnect();
    micSource.current = null;
    setMicAnalyser(null);
    setInterim("");
  }, [discardCapture]);

  // ------------------------------------------------------------------ speaking

  const afterSpeaking = useCallback((generation: number) => {
    if (!alive(generation)) return;
    if (endAfterSpeaking.current) {
      endAfterSpeaking.current = false;
      void endRef.current();
      return;
    }
    setAgentState("Listening");
    listen();
  }, [alive, listen, setAgentState]);

  const speak = useCallback(async (text: string, generation: number, options: { after?: Promise<unknown>; onStart?: (engine: VoiceEngine) => void } = {}) => {
    if (!alive(generation)) return;
    const line = ++speechEpoch.current;
    pauseListening();
    const result = await player().speak(text, {
      engine: engine(),
      voice: voiceName(),
      language: languageRef.current,
      onMissingVoice: lang => noticeOnce(`This device has no ${languageByCode(lang).label} voice installed, so Aria can't speak it aloud (her reply is still in the transcript). Edge on Windows includes natural Indian voices; on other systems add one in the speech settings.`),
      after: options.after,
      onStart: used => {
        if (line !== speechEpoch.current || !alive(generation)) return;
        setAgentState("Speaking");
        options.onStart?.(used);
      },
      onFallback: (reason, permanent) => {
        if (permanent) voiceDegraded.current = true;
        noticeOnce(permanent ? `${reason} Aria will use your browser's voice for the rest of this call.` : reason);
      },
    });
    if (!alive(generation) || line !== speechEpoch.current) return;
    if (!result.completed) {
      reportProblem("speech");
      noticeOnce("Aria's audio couldn't play in this browser. Her replies are still shown in the transcript.");
    }
    afterSpeaking(generation);
  }, [afterSpeaking, alive, engine, noticeOnce, pauseListening, player, reportProblem, setAgentState]);

  const speakGreeting = useCallback(async (generation: number) => {
    if (engine() !== "browser" && languageRef.current === "en-IN") {
      const line = ++speechEpoch.current;
      const played = await clip("greeting", () => {
        if (line === speechEpoch.current && alive(generation)) setAgentState("Speaking");
      });
      if (!alive(generation) || line !== speechEpoch.current) return;
      if (played) {
        afterSpeaking(generation);
        return;
      }
    }
    await speak(greetingFor(languageRef.current, brandRef.current), generation);
  }, [afterSpeaking, alive, engine, player, setAgentState, speak]);

  // ------------------------------------------------------------------ one customer turn

  const send = useCallback(async (raw: string, via: "voice" | "text" = "text") => {
    const content = raw.trim().slice(0, 2000);
    if (!content || phaseRef.current !== "live" || request.current) return;
    silenceChecks.current = 0;
    if (transcript.current.filter(e => e.role === "user").length >= MAX_CUSTOMER_TURNS) {
      setNotice({ tone: "warning", text: "This call has reached 60 turns. End it to see the summary, then start a new call." });
      return;
    }
    if (stateRef.current === "Speaking") markInterrupted();
    speechEpoch.current++;
    player().stop();
    pauseListening();
    setNotice(null);
    clearInterrupted();
    clearProblem();

    const generation = epoch.current;
    turn.current++;
    const currentTurn = turn.current;
    // An unanswered confirmation from an earlier turn can never complete now.
    setActions(items => supersedeConfirmations(items, currentTurn));
    const startedAt = via === "voice" && performance.now() - lastSpeechAt.current < 4000 ? lastSpeechAt.current : performance.now();
    addEntry({ role: "user", content, via });
    log({ kind: "heard", title: via === "voice" ? `Heard · ${speechPathRef.current === "gemini" ? "Gemini transcription" : "browser speech recognition"}` : "Typed message", detail: content });
    setAgentState("Thinking", "Thinking");

    const controller = new AbortController();
    request.current = controller;
    let timedOut = false;
    const requestTimer = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, REQUEST_TIMEOUT_MS);
    const tools: ToolName[] = [];
    let filler: Promise<boolean> | undefined;
    let modelLog: string | undefined;
    let modelMs = 0;
    let rounds = 0;
    try {
      const response = await fetch("/api/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ messages: transcript.current.map(({ role, content }) => ({ role, content })), session: sessionToken.current, language: languageRef.current, brand: brandRef.current }),
        signal: controller.signal,
      });
      if (!response.ok || !response.body) {
        const data = await response.json().catch(() => ({}));
        throw new Error(data.error || "Aria couldn't respond just now. Please try again.");
      }

      let reply: { text: string; source: ReplySource } | null = null;
      let done: Extract<ChatStreamEvent, { type: "done" }> | null = null;
      for await (const event of readNdjson<ChatStreamEvent>(response.body)) {
        if (!alive(generation)) return;
        switch (event.type) {
          case "tool_call":
            tools.push(event.name);
            log({ id: event.id, kind: "tool", title: event.name, detail: formatArgs(event.args), status: "running" });
            setStatusLabel(thinkingLabel(event.name, event.args));
            setActions(items => recordAction(items, startAction(event, currentTurn)));
            // Tools run synchronously on the server; a missing result means the stream stalled.
            clearActionTimer(event.id);
            actionTimers.current.set(event.id, setTimeout(() => {
              actionTimers.current.delete(event.id);
              setActions(items => markActionUnresolved(items, event.id));
            }, ACTION_TIMEOUT_MS));
            // A lookup needs another model round; cover the gap like a human agent would.
            // The clip is English, so it would jar in a Hindi or Tamil call.
            if (!filler && configRef.current?.mode === "ai" && engine() !== "browser" && languageRef.current === "en-IN" && (event.name === "get_order_details" || event.name === "escalate_to_human")) {
              filler = clip("filler");
            }
            break;
          case "tool_result":
            clearActionTimer(event.id);
            updateLog(event.id, { status: TOOL_STATUS[event.status], detail: event.summary, ms: event.ms });
            setActions(items => applyActionResult(items, event));
            break;
          case "guardrail":
            log({ kind: "guardrail", title: event.rule, detail: event.detail, status: "warn" });
            break;
          case "model":
            rounds++;
            modelMs += event.ms;
            if (!modelLog) modelLog = log({ kind: "model", title: event.model, detail: "1 reasoning round", ms: modelMs, status: "ok" });
            else updateLog(modelLog, { detail: `${rounds} reasoning rounds`, ms: modelMs });
            break;
          case "reply":
            reply = { text: event.text, source: event.source };
            break;
          case "done":
            done = event;
            break;
          case "error":
            throw new Error(event.message);
        }
      }
      if (!reply || !done) throw new Error("The connection dropped before Aria could answer. Please try again.");
      // The stream is complete; Aria's spoken reply must not count against the request timeout.
      clearTimeout(requestTimer);
      request.current = null;
      clearActionTimers();
      // A completed turn must never leave a call pending; the signed session is then the final
      // authority for a completed cancellation.
      setActions(items => reconcileCancelled(
        markTurnUnresolved(items, currentTurn, "The turn finished without a result for this check. Nothing is confirmed."),
        done.cancelled,
      ));
      sessionToken.current = done.session;
      setCancelled(done.cancelled);
      setTickets(done.tickets ?? []);
      endAfterSpeaking.current = done.endCall;

      const replyAt = performance.now();
      const entryId = addEntry({ role: "assistant", content: reply.text, tools, source: reply.source });
      if (reply.source === "direct") log({ kind: "guardrail", title: "Answered from the order record", detail: "A plain status question: the server spoke the verified facts without a model call.", status: "ok" });
      if (reply.source === "policy") log({ kind: "guardrail", title: "Policy decision spoken verbatim", detail: "The server's wording was used, so the model can't soften or change it.", status: "ok" });
      setStatusLabel("Preparing voice");
      await speak(reply.text, generation, {
        after: filler,
        onStart: used => {
          const latency = Math.round(performance.now() - startedAt);
          updateEntry(entryId, { latencyMs: latency });
          latencyLog.current = [...latencyLog.current, latency];
          setLatencies(latencyLog.current);
          const provider = configRef.current?.voiceProvider;
          const voiceLabel = used === "browser" || !provider
            ? "Browser voice"
            : `${VOICE_PROVIDER_LABEL[provider]} · ${spokenVoiceLabel()}`;
          log({ kind: "voice", title: voiceLabel, detail: `Speaking ${Math.round(performance.now() - replyAt)} ms after the reply arrived`, ms: latency, status: "ok" });
        },
      });
    } catch (error) {
      if (!alive(generation)) return;
      clearActionTimers();
      if (controller.signal.aborted && !timedOut) return;
      player().stop();
      reportProblem("connection");
      const message = timedOut
        ? "Aria took too long to check that. Nothing has been changed, so please try again."
        : error instanceof Error ? error.message : "Something went wrong. Please try again.";
      // A failed or timed-out turn can never confirm a transaction.
      setActions(items => markTurnUnresolved(
        items,
        currentTurn,
        timedOut
          ? "The check timed out before the server returned a result. Nothing is confirmed."
          : "The connection dropped before this finished. Nothing is confirmed.",
      ));
      setNotice({ tone: "error", text: message });
      log({ kind: "error", title: timedOut ? "Check timed out" : "Turn failed", detail: message, status: "error" });
      setAgentState("Listening");
      listen();
    } finally {
      clearTimeout(requestTimer);
      if (request.current === controller) request.current = null;
    }
  }, [addEntry, alive, clearActionTimer, clearActionTimers, clearInterrupted, clearProblem, engine, listen, log, markInterrupted, pauseListening, player, reportProblem, setAgentState, speak, updateEntry, updateLog]);

  useEffect(() => {
    submitRef.current = send;
  }, [send]);

  // ------------------------------------------------------------------ call lifecycle

  const wireRecognition = useCallback((rec: Recognition) => {
    rec.onresult = event => {
      if (phaseRef.current !== "live" || mutedRef.current || stateRef.current !== "Listening") return;
      lastSpeechAt.current = performance.now();
      let partial = "";
      for (let i = event.resultIndex; i < event.results.length; i++) {
        const result = event.results[i];
        if (result.isFinal) finalBuffer.current = `${finalBuffer.current} ${result[0].transcript}`.trim();
        else partial += result[0].transcript;
      }
      setInterim(`${finalBuffer.current} ${partial}`.trim());
      if (commitTimer.current) clearTimeout(commitTimer.current);
      commitTimer.current = null;
      if (partial.trim() || !finalBuffer.current) return;
      // Wait briefly in case the caller is mid-sentence; longer if it sounds unfinished.
      commitTimer.current = setTimeout(() => {
        const text = finalBuffer.current;
        finalBuffer.current = "";
        commitTimer.current = null;
        if (text) void submitRef.current(text, "voice");
      }, commitDelay(finalBuffer.current));
    };
    rec.onerror = event => {
      if (phaseRef.current !== "live" || stateRef.current !== "Listening") return;
      if (event.error === "aborted" || event.error === "no-speech") return;
      if (["not-allowed", "service-not-allowed", "audio-capture", "network"].includes(event.error)) {
        if (configRef.current?.cloudTranscription && "MediaRecorder" in window) {
          speechPathRef.current = "gemini";
          setSpeechPath("gemini");
          setNotice({ tone: "info", text: "Browser speech recognition isn't available, so Aria switched to Gemini transcription. Please repeat your question." });
          log({ kind: "system", title: "Switched to Gemini transcription", detail: `Browser recognition error: ${event.error}` });
          listen();
        } else {
          textModeRef.current = true;
          setTextMode(true);
          reportProblem("speech");
          setNotice({ tone: "warning", text: "Speech recognition is unavailable here. You can continue the call by typing." });
        }
      }
    };
    rec.onend = () => {
      if (phaseRef.current !== "live" || speechPathRef.current !== "browser" || textModeRef.current || mutedRef.current || stateRef.current !== "Listening") return;
      // Chrome ends recognition after a pause; send anything already recognised, then keep listening.
      if (finalBuffer.current && !commitTimer.current) {
        const text = finalBuffer.current;
        finalBuffer.current = "";
        void submitRef.current(text, "voice");
        return;
      }
      restartTimer.current = setTimeout(listen, 200);
    };
  }, [listen, log, reportProblem]);

  const start = useCallback(async ({ text = false, firstMessage }: { text?: boolean; firstMessage?: string } = {}) => {
    const cfg = configRef.current;
    if (phaseRef.current !== "idle" || !cfg) return;
    player().unlock(); // must happen synchronously inside the click
    previewEpoch.current++;
    player().stop();
    setPreviewing(false);

    const generation = ++epoch.current;
    setPhase("starting");
    setAgentState("Idle");
    transcript.current = [];
    setEntries([]);
    setActivity([]);
    clearActionTimers();
    setActions([]);
    setSummary(null);
    setTickets([]);
    setEnded(false);
    setCancelled([]);
    setElapsed(0);
    setNotice(null);
    clearInterrupted();
    clearProblem();
    latencyLog.current = [];
    setLatencies([]);
    warnOnce.current.clear();
    sessionToken.current = undefined;
    turn.current = 0;
    voiceDegraded.current = false;
    silenceChecks.current = 0;
    endAfterSpeaking.current = false;
    mutedRef.current = false;
    setMuted(false);
    textModeRef.current = text;
    setTextMode(text);
    speechPathRef.current = null;
    setSpeechPath(null);

    if (!text) {
      try {
        const rec = inputEngine === "gemini" ? null : createRecognition(languageRef.current);
        const canTranscribe = cfg.cloudTranscription && "MediaRecorder" in window;
        if (!rec && !canTranscribe) throw new Error("Voice recognition isn't available in this browser. Try Chrome or Edge, or start a text chat instead.");
        const mic = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true } });
        if (generation !== epoch.current) {
          mic.getTracks().forEach(track => track.stop());
          return;
        }
        stream.current = mic;
        const context = player().audioContext();
        const source = context.createMediaStreamSource(mic);
        const analyser = context.createAnalyser();
        analyser.fftSize = 512;
        analyser.smoothingTimeConstant = 0.6;
        source.connect(analyser);
        micSource.current = source;
        setMicAnalyser(analyser);
        speechPathRef.current = rec ? "browser" : "gemini";
        setSpeechPath(speechPathRef.current);
        recognition.current = rec;
        if (rec) wireRecognition(rec);
        phaseRef.current = "live"; // the VAD loop checks this synchronously
        runVad(analyser);
      } catch (error) {
        if (generation !== epoch.current) return;
        teardownAudio();
        setPhase("idle");
        const blocked = error instanceof DOMException && (error.name === "NotAllowedError" || error.name === "SecurityError");
        reportProblem(error instanceof DOMException ? "microphone" : "speech");
        setNotice({
          tone: "error",
          text: blocked
            ? "Microphone access was blocked. Allow it from the icon in the address bar, or start a text chat instead."
            : error instanceof Error ? error.message : "The microphone couldn't start. You can start a text chat instead.",
        });
        return;
      }
    }

    callStartedAt.current = Date.now();
    setPhase("live");
    // Fetch the "let me check" clip now so it's ready for the first lookup.
    if (engine() === "premium" && languageRef.current === "en-IN") void player().loadClip(cfg.voiceProvider, voiceName(), "filler", brandRef.current);
    // Reopen the server's voice connection for this call's language before the first reply needs it.
    if (engine() === "premium") void fetch(`/api/tts-stream?language=${languageRef.current}&voice=${encodeURIComponent(voiceName() ?? "")}`).catch(() => {});
    log({ kind: "system", title: "Call started", detail: text ? "Text chat · Aria still speaks her replies" : `Voice call · ${speechPathRef.current === "gemini" ? "Gemini" : "browser"} speech recognition · barge-in ${bargeInRef.current ? "on" : "off"}` });
    addEntry({ role: "assistant", content: greetingFor(languageRef.current, brandRef.current), source: "greeting" });
    // A plain device voice (e.g. Chrome's Microsoft Zira) sounds robotic; Edge has natural Indian ones.
    const deviceVoice = engine() === "browser" && !isEdge() && "speechSynthesis" in window ? pickVoice(speechSynthesis.getVoices(), languageRef.current) : null;
    if (deviceVoice && !isNaturalVoice(deviceVoice.name)) noticeOnce(`Aria is speaking with ${deviceVoice.name}. ${EDGE_TIP}`, "info");
    if (firstMessage) {
      setAgentState("Listening");
      void send(firstMessage, "text");
      return;
    }
    setAgentState("Thinking", "Connecting");
    await speakGreeting(generation);
  }, [addEntry, clearActionTimers, clearInterrupted, clearProblem, engine, inputEngine, log, noticeOnce, player, reportProblem, runVad, send, setAgentState, setPhase, speakGreeting, teardownAudio, wireRecognition]);

  const end = useCallback(async () => {
    clearInterrupted();
    clearProblem();
    if (phaseRef.current === "starting") {
      epoch.current++;
      teardownAudio();
      setPhase("idle");
      setNotice({ tone: "info", text: "Microphone setup cancelled. You can start a text chat instead." });
      return;
    }
    if (phaseRef.current !== "live") return;
    if (stateRef.current === "Speaking") markInterrupted();
    epoch.current++;
    speechEpoch.current++;
    request.current?.abort();
    request.current = null;
    // An interrupted turn cannot have completed an action.
    clearActionTimers();
    setActions(items => markTurnUnresolved(items, turn.current, "The call ended before this finished. The outcome is unknown."));
    transcribeRequest.current?.abort();
    player().stop();
    teardownAudio();
    setPhase("ending");
    setAgentState("Idle");
    const durationSeconds = Math.round((Date.now() - callStartedAt.current) / 1000);
    const endLog = log({ kind: "system", title: "Call ended", detail: "Writing the post-call summary…", status: "running" });

    const avg = latencyLog.current.length ? Math.round(latencyLog.current.reduce((a, b) => a + b, 0) / latencyLog.current.length) : null;
    try {
      const response = await fetch("/api/summary", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          session: sessionToken.current,
          transcript: transcript.current.map(({ role, content }) => ({ role, content })),
          channel: textModeRef.current ? "text" : "voice",
          metrics: { duration_seconds: durationSeconds, avg_response_ms: avg },
        }),
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error);
      setSummary(data);
      updateLog(endLog, { status: "ok", detail: data.generated_by === "rules" ? "Summary built from the verified tool log" : `Summary written by ${data.generated_by}, checked against the tool log` });
    } catch {
      updateLog(endLog, { status: "error", detail: "Summary unavailable" });
      setNotice({ tone: "warning", text: "The summary couldn't be generated. Your transcript is still available to download." });
    } finally {
      setPhase("idle");
      setEnded(true);
    }
  }, [clearActionTimers, clearInterrupted, clearProblem, log, markInterrupted, player, setAgentState, setPhase, teardownAudio, updateLog]);

  useEffect(() => {
    endRef.current = end;
  }, [end]);

  // ------------------------------------------------------------------ controls

  const ask = useCallback((text: string) => {
    if (phaseRef.current === "live") void send(text, "text");
    else if (phaseRef.current === "idle") void start({ text: true, firstMessage: text });
  }, [send, start]);

  const toggleMute = useCallback(() => {
    const value = !mutedRef.current;
    mutedRef.current = value;
    setMuted(value);
    stream.current?.getAudioTracks().forEach(track => {
      track.enabled = !value;
    });
    if (value) pauseListening();
    else listen();
  }, [listen, pauseListening]);

  const interrupt = useCallback(() => {
    if (stateRef.current !== "Speaking") return;
    handleBargeIn();
  }, [handleBargeIn]);

  const setVoice = useCallback((value: VoiceChoice) => {
    previewEpoch.current++;
    player().stop();
    setPreviewing(false);
    voiceRef.current = value;
    setVoiceState(value);
  }, [player]);

  const setLanguage = useCallback((code: string) => {
    // A call stays in the language it started in; the selector is only enabled between calls.
    if (phaseRef.current === "live" || phaseRef.current === "ending") return;
    if (!LANGUAGES.some(item => item.code === code)) return;
    previewEpoch.current++;
    player().stop();
    setPreviewing(false);
    languageRef.current = code;
    setLanguageState(code);
    try {
      localStorage.setItem("aria-language", code);
    } catch {
      // Storage can be blocked; the choice still applies to this session.
    }
  }, [player]);

  /** Which brand the next call is for. Fixed during a call; returns false if a call is running. */
  const setBrand = useCallback((id: BrandId) => {
    if (phaseRef.current !== "idle") return false;
    previewEpoch.current++;
    player().stop();
    setPreviewing(false);
    if (brandRef.current !== id) {
      transcript.current = [];
      setEntries([]);
      setActivity([]);
      clearActionTimers();
      setActions([]);
      setSummary(null);
      setTickets([]);
      setEnded(false);
      setCancelled([]);
      setElapsed(0);
      setNotice(null);
      clearInterrupted();
      clearProblem();
      latencyLog.current = [];
      setLatencies([]);
      sessionToken.current = undefined;
      turn.current = 0;
    }
    brandRef.current = id;
    setBrandState(id);
    return true;
  }, [clearActionTimers, clearInterrupted, clearProblem, player]);

  const setBargeIn = useCallback((value: boolean) => {
    bargeInRef.current = value;
    setBargeInState(value);
  }, []);

  const previewVoice = useCallback(async () => {
    if (phaseRef.current !== "idle") return;
    const generation = ++previewEpoch.current;
    if (previewing) {
      player().stop();
      setPreviewing(false);
      return;
    }
    player().unlock();
    setPreviewing(true);
    const choice = engine();
    let played = false;
    if (choice !== "browser" && languageRef.current === "en-IN") played = await clip("greeting");
    if (!played && generation === previewEpoch.current) {
      await player().speak(greetingFor(languageRef.current, brandRef.current), {
        engine: choice,
        voice: voiceName(),
        language: languageRef.current,
        onFallback: reason => setNotice({ tone: "warning", text: reason }),
        onMissingVoice: lang => setNotice({ tone: "warning", text: `This device has no ${languageByCode(lang).label} voice installed. Edge on Windows includes natural Indian voices.` }),
      });
    }
    if (generation === previewEpoch.current) setPreviewing(false);
  }, [engine, player, previewing]);

  const dismissNotice = useCallback(() => setNotice(null), []);

  /** Satisfaction feedback for the finished call. Resolves only after the server confirms a save. */
  const submitFeedback = useCallback(async (rating: number, comment: string) => {
    const token = sessionToken.current;
    if (!token) throw new Error("Start a call before leaving feedback.");
    const response = await fetch("/api/feedback", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ session: token, rating, comment: comment.slice(0, 500) }),
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok || !data.saved) throw new Error(data.error || "Feedback couldn't be saved. Please try again.");
    return { rating: data.rating as number };
  }, []);

  // ------------------------------------------------------------------ effects

  useEffect(() => {
    // Read after hydration so the server-rendered page and the first client render agree.
    const fromUrl = new URLSearchParams(window.location.search).get("brand");
    if (isBrandId(fromUrl)) {
      brandRef.current = fromUrl;
      setBrandState(fromUrl);
    }
    try {
      const saved = localStorage.getItem("aria-language");
      if (saved && LANGUAGES.some(item => item.code === saved)) {
        languageRef.current = saved;
        setLanguageState(saved);
      }
    } catch {
      // Private mode or blocked storage: keep the default.
    }
    fetch("/api/config")
      .then(response => {
        if (!response.ok) throw new Error();
        return response.json() as Promise<AppConfig>;
      })
      .then(data => {
        configRef.current = data;
        setConfig(data);
        const initial: VoiceChoice = data.voiceProvider && data.defaultVoice ? data.defaultVoice : "browser";
        voiceRef.current = initial;
        setVoiceState(initial);
      })
      .catch(() => {
        reportProblem("connection");
        setNotice({ tone: "error", text: "Couldn't reach Aria's server. Please refresh the page." });
      });
    window.speechSynthesis?.getVoices();
    return () => {
      // Unmount (or a dev hot reload): stop everything and keep refs and visible state in agreement.
      epoch.current++;
      phaseRef.current = "idle";
      stateRef.current = "Idle";
      setPhaseState("idle");
      setAgentStateValue("Idle");
      if (interruptedTimer.current) clearTimeout(interruptedTimer.current);
      interruptedTimer.current = null;
      if (problemTimer.current) clearTimeout(problemTimer.current);
      problemTimer.current = null;
      clearActionTimers();
      request.current?.abort();
      request.current = null;
      transcribeRequest.current?.abort();
      teardownAudio();
      playerRef.current?.dispose();
    };
  }, [clearActionTimers, reportProblem, teardownAudio]);

  useEffect(() => {
    if (phase !== "live") return;
    const interval = setInterval(() => setElapsed(Math.round((Date.now() - callStartedAt.current) / 1000)), 1000);
    return () => clearInterval(interval);
  }, [phase]);

  // A caller who goes quiet gets one check-in, then a polite goodbye: a phone agent doesn't hold a
  // silent line forever. Text chats are exempt (pausing to type is normal), and so is a muted mic.
  useEffect(() => {
    if (phase !== "live" || textMode || muted) return;
    let listeningSince = 0;
    const interval = setInterval(() => {
      const now = performance.now();
      if (stateRef.current !== "Listening" || request.current) {
        listeningSince = 0;
        return;
      }
      listeningSince ||= now;
      const heard = Math.max(listeningSince, lastSpeechAt.current, vad.current.lastVoiceAt);
      const final = silenceChecks.current > 0;
      if (now - heard < (final ? SILENCE_GOODBYE_MS : SILENCE_CHECK_MS)) return;
      listeningSince = 0;
      silenceChecks.current++;
      const line = silenceLine(languageRef.current, final ? "goodbye" : "check");
      addEntry({ role: "assistant", content: line, source: "check-in" });
      log({ kind: "system", title: final ? "Ended a silent call" : "Checked on a silent caller", detail: final ? "Still no reply, so Aria said goodbye and hung up." : `No speech for ${SILENCE_CHECK_MS / 1000} s, so Aria asked if the caller is still there.` });
      if (final) endAfterSpeaking.current = true;
      void speak(line, epoch.current);
    }, 1000);
    return () => clearInterval(interval);
  }, [addEntry, log, muted, phase, speak, textMode]);

  // Info notices clear themselves; warnings and errors stay until dismissed.
  useEffect(() => {
    if (notice?.tone !== "info") return;
    const timer = setTimeout(() => setNotice(current => (current === notice ? null : current)), 6000);
    return () => clearTimeout(timer);
  }, [notice]);

  return {
    config,
    phase,
    agentState,
    statusLabel,
    muted,
    textMode,
    speechPath,
    entries,
    interim,
    activity,
    actions,
    notice,
    summary,
    tickets,
    ended,
    cancelled,
    elapsed,
    micAnalyser,
    outputAnalyser: playerRef.current?.analyser ?? null,
    voice,
    inputEngine,
    language,
    brand,
    bargeIn,
    previewing,
    latencies,
    interrupted,
    problem,
    start,
    end,
    send,
    ask,
    toggleMute,
    interrupt,
    setVoice,
    setLanguage,
    setBrand,
    setInputEngine,
    setBargeIn,
    previewVoice,
    dismissNotice,
    submitFeedback,
  };
}

export type VoiceCall = ReturnType<typeof useVoiceCall>;
