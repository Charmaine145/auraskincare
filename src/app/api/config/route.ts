import { getProvider, modelLabel } from "@/lib/agent/providers";
import { after } from "next/server";
import { voiceInfo, warmTts } from "@/lib/voice/tts";
import type { AppConfig } from "@/types";

export const dynamic = "force-dynamic";

/** Tells the page which engines are available. Never exposes keys. */
export function GET() {
  const provider = getProvider();
  const voice = voiceInfo();
  // Aria's first reply shouldn't pay for opening the voice connection. after() keeps a serverless function alive for it.
  after(() => warmTts());
  const config: AppConfig = {
    mode: provider ? "ai" : "demo",
    provider: provider?.name ?? null,
    model: provider?.model ?? null,
    modelLabel: provider ? modelLabel(provider.model) : null,
    voiceProvider: voice.voiceProvider,
    voices: voice.voices,
    defaultVoice: voice.defaultVoice,
    voiceLanguages: voice.voiceLanguages,
    cloudTranscription: Boolean(process.env.GEMINI_API_KEY),
  };
  return Response.json(config);
}
