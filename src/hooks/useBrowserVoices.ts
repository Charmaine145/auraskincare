"use client";

import { useEffect, useState } from "react";
import { voiceReport, type VoiceReport } from "@/lib/voice/browserVoices";
import { LANGUAGES } from "@/lib/voice/languages";

/** Which voice this device would use for each language (the list loads asynchronously). */
export function useBrowserVoices(): VoiceReport[] {
  const [report, setReport] = useState<VoiceReport[]>(() => LANGUAGES.map(l => ({ code: l.code, label: l.label, native: l.native, voice: null })));

  useEffect(() => {
    const synth = window.speechSynthesis;
    if (!synth) return;
    const update = () => setReport(voiceReport(synth.getVoices()));
    update();
    synth.addEventListener("voiceschanged", update);
    return () => synth.removeEventListener("voiceschanged", update);
  }, []);

  return report;
}
