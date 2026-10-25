import { brandById, DEFAULT_BRAND } from "@/data/brand";

/** Aria's English greeting for a brand (other languages: greetingFor in languages.ts). */
export const greetingText = (brand?: string) => brandById(brand).greetings["en-IN"];
export const GREETING = greetingText(DEFAULT_BRAND);
export const FILLER = "Sure, let me check that for you.";
export const CLIP_NAMES = ["greeting", "filler"] as const;
export type ClipName = (typeof CLIP_NAMES)[number];
export const clipText = (clip: ClipName, brand?: string) => (clip === "greeting" ? greetingText(brand) : FILLER);

/**
 * Pre-recorded clips live at /audio/<provider>/<voice>-<clip>.wav (see scripts/generate-voice-clips.ts).
 * They play instantly and cost no quota; if one is missing the browser asks /api/tts once instead.
 */
/** Providers with clips in public/audio; the others get theirs from /api/tts (cached on the server). */
export const PRERECORDED_CLIPS = new Set(["gemini"]);
/** The recorded greeting names Aura, so other brands' greetings are synthesised instead. */
export const hasRecordedClip = (provider: string, clip: ClipName, brand?: string) =>
  PRERECORDED_CLIPS.has(provider) && (clip === "filler" || brandById(brand).id === DEFAULT_BRAND);
export const clipUrl = (provider: string, voice: string, clip: ClipName) => `/audio/${provider}/${voice.toLowerCase()}-${clip}.wav`;

export const VOICE_PROVIDER_LABEL: Record<string, string> = {
  edge: "Edge Neural",
  azure: "Azure Neural",
  sarvam: "Sarvam Bulbul",
  openai: "OpenAI",
  gemini: "Gemini",
};
