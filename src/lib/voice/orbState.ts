import type { AgentState } from "@/types";

/**
 * What the orb is showing. This is derived from real call state only: the call phase,
 * Aria's agent state, a live interruption and any failure the call engine reported.
 * Nothing here is a decorative guess, and "listening" is never shown without a live call.
 */
export type OrbState = "idle" | "listening" | "processing" | "speaking" | "interrupted" | "error";

/** A real problem the orb should surface. Auto-clears in the call engine, the notice stays. */
export type OrbProblem = "microphone" | "speech" | "connection" | null;

export interface OrbStateInput {
  phase: "idle" | "starting" | "live" | "ending";
  agentState: AgentState;
  /** True for a short moment after the caller interrupts Aria. */
  interrupted: boolean;
  problem: OrbProblem;
}

/**
 * Priority: a real failure, then active work (processing/speaking), then the interruption
 * cue, then plain listening. A new request therefore never shows "interrupted" over its
 * "processing" state, and the microphone is never implied when no call is live.
 */
export function orbStateFor({ phase, agentState, interrupted, problem }: OrbStateInput): OrbState {
  if (problem) return "error";
  if (phase === "starting" || phase === "ending") return "processing";
  if (phase !== "live") return "idle";
  if (agentState === "Thinking") return "processing";
  if (agentState === "Speaking") return "speaking";
  if (agentState === "Listening") return interrupted ? "interrupted" : "listening";
  return "idle";
}
