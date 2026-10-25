/** Minimal typing for the browser Web Speech API (not in TypeScript's DOM lib). */
export interface RecognitionResult {
  isFinal: boolean;
  0: { transcript: string };
  length: number;
}
export interface RecognitionEvent {
  resultIndex: number;
  results: { [index: number]: RecognitionResult; length: number };
}
export interface Recognition {
  lang: string;
  continuous: boolean;
  interimResults: boolean;
  onresult: ((event: RecognitionEvent) => void) | null;
  onerror: ((event: { error: string }) => void) | null;
  onend: (() => void) | null;
  start(): void;
  stop(): void;
  abort(): void;
}
type SpeechWindow = Window & { SpeechRecognition?: new () => Recognition; webkitSpeechRecognition?: new () => Recognition };

/** Chrome/Edge/Safari speech recognition. `lang` is the call language (en-IN, hi-IN, ta-IN…). */
export function createRecognition(lang = "en-IN"): Recognition | null {
  const w = window as SpeechWindow;
  const Constructor = w.SpeechRecognition || w.webkitSpeechRecognition;
  if (!Constructor) return null;
  const recognition = new Constructor();
  recognition.lang = lang;
  recognition.continuous = true;
  recognition.interimResults = true;
  return recognition;
}

const TRAILING_WORD = /\b(ord|order|id|number|is|my|the|a|an|and|to|for|of|about|with|um+|uh+|er|hmm+|so|but|because|like|please|mera|meri|ka|ki|ke)$/;
const PARTIAL_ID = /\b(ord|order)(\s*[-\s]\s*(zero|oh|o|one|two|three|four|five|six|seven|eight|nine|\d{1,2})){0,2}$/;

/**
 * How long to wait after the recognizer's final result before sending the turn.
 * Short when the sentence sounds complete, longer when the caller is mid-thought
 * ("my order is ...", "ORD one zero ..."), so a pause doesn't cut them off.
 */
export function commitDelay(text: string): number {
  const t = text.trim().toLowerCase().replace(/[.,!?]+$/, "");
  if (!t) return 0;
  return TRAILING_WORD.test(t) || PARTIAL_ID.test(t) ? 1400 : 350;
}
