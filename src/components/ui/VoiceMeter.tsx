"use client";

import { useEffect, useState, type CSSProperties } from "react";
import type { AgentState } from "@/types";

/**
 * A small live voice-activity meter. It reads the existing analyser — no second audio
 * pipeline — and falls back to a calm CSS pulse when no microphone is connected.
 */
export function VoiceMeter({ analyser, state, muted, activityOnly = false }: { analyser: AnalyserNode | null; state: AgentState; muted: boolean; activityOnly?: boolean }) {
  const [level, setLevel] = useState(0);

  useEffect(() => {
    if (!analyser) {
      setLevel(0);
      return;
    }
    const data = new Uint8Array(analyser.frequencyBinCount);
    let frame = 0;
    let smoothed = 0;
    const tick = () => {
      analyser.getByteTimeDomainData(data);
      let sum = 0;
      for (const value of data) {
        const centred = (value - 128) / 128;
        sum += centred * centred;
      }
      const rms = Math.sqrt(sum / data.length);
      smoothed = smoothed * 0.72 + Math.min(1, rms * 7) * 0.28;
      setLevel(smoothed);
      frame = requestAnimationFrame(tick);
    };
    tick();
    return () => cancelAnimationFrame(frame);
  }, [analyser]);

  const active = !muted && (state === "Listening" || state === "Speaking" || (!activityOnly && state === "Thinking"));
  const sounding = active && level >= 0.16;
  const style = { "--level": activityOnly ? (sounding ? level.toFixed(3) : "0") : active ? Math.max(0.08, level).toFixed(3) : "0.06" } as CSSProperties;

  return (
    <span className={`voice-meter${activityOnly ? " activity-meter" : ""}`} style={style} data-state={state} data-muted={muted || undefined} data-active={activityOnly && sounding ? "" : undefined} aria-hidden>
      {[0.55, 0.85, 1, 0.7, 0.45].map((weight, index) => (
        <i key={index} style={{ "--weight": weight } as CSSProperties} />
      ))}
    </span>
  );
}
