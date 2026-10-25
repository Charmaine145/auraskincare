import { LANGUAGES } from "./languages";

type NamedVoice = { name: string; lang: string };

const normalize = (lang: string) => lang.replace("_", "-").toLowerCase();

// Voice names that reveal gender (Microsoft's Indian voices); Google's voices don't say.
const FEMALE = /female|heera|neerja|aditi|priya|kajal|swara|kalpana|pallavi|shruti|tanishaa|aarohi|dhwani|sapna|sobhana|ananya|kavya|zira|jenny|aria|sonia|samantha|susan|hazel/i;
const MALE = /(^|[\s-])male\b|\bravi\b|prabhat|hemant|madhur|valluvar|mohan|bashkar|manohar|niranjan|gagan|midhun|kumar/i;

/** Neural voices: Edge's "Online (Natural)" Microsoft voices and similar. Plain SAPI voices sound robotic. */
export const isNaturalVoice = (name: string) => /natural|online|neural/i.test(name);

/** Edge is the one desktop browser that ships natural Indian voices (Neerja, Swara, Pallavi…). */
export const isEdge = () => typeof navigator !== "undefined" && /\bEdg\//.test(navigator.userAgent);

export const EDGE_TIP = "For a natural Indian voice, open this page in Microsoft Edge.";

/**
 * Picks the best installed voice for a language: a neural ("Natural"/"Online") voice beats a
 * plain one, an exact region (hi-IN) beats a neighbour (hi), and a female voice suits Aria.
 * Returns null when the device has no voice for that language at all.
 */
export function pickVoice<T extends NamedVoice>(voices: T[], lang: string): T | null {
  const wanted = normalize(lang);
  const primary = wanted.split("-")[0];
  const score = (voice: T) => {
    const name = voice.name;
    return (normalize(voice.lang) === wanted ? 20 : 0)
      + (isNaturalVoice(name) ? 40 : 0)
      + (/google/i.test(name) ? 12 : 0)
      + (FEMALE.test(name) && !/^male/i.test(name) ? 30 : 0)
      - (MALE.test(name) && !FEMALE.test(name) ? 30 : 0);
  };
  return voices.filter(v => normalize(v.lang).split("-")[0] === primary).sort((a, b) => score(b) - score(a))[0] ?? null;
}

/** Indian English first: any English voice is acceptable, but en-IN is preferred. */
export const pickBrowserVoice = <T extends NamedVoice>(voices: T[]) => pickVoice(voices, "en-IN");

export interface VoiceReport {
  code: string;
  label: string;
  native: string;
  voice: string | null;
}

/** Which voice Aria would use for each language on this device, or null if none is installed. */
export function voiceReport(voices: NamedVoice[]): VoiceReport[] {
  return LANGUAGES.map(({ code, label, native }) => ({ code, label, native, voice: pickVoice(voices, code)?.name ?? null }));
}

/** Resolves once the browser has loaded its voice list (it loads asynchronously). */
export function voicesReady(timeoutMs = 1200): Promise<SpeechSynthesisVoice[]> {
  const synth = typeof window !== "undefined" ? window.speechSynthesis : undefined;
  if (!synth) return Promise.resolve([]);
  if (synth.getVoices().length) return Promise.resolve(synth.getVoices());
  return new Promise(resolve => {
    const done = () => {
      clearTimeout(timer);
      synth.removeEventListener("voiceschanged", done);
      resolve(synth.getVoices());
    };
    const timer = setTimeout(done, timeoutMs);
    synth.addEventListener("voiceschanged", done);
  });
}
