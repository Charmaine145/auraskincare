import { brandById } from "@/data/brand";

/**
 * Languages Aria can hear and speak through the browser's built-in voices. Which ones actually
 * work depends on the voices installed on the caller's device (Edge on Windows ships natural
 * Hindi, Tamil, Telugu, Bengali, Marathi, Gujarati, Kannada and Malayalam voices).
 */
export interface Language {
  code: string;
  label: string;
  native: string;
}

export const LANGUAGES: Language[] = [
  { code: "en-IN", label: "English", native: "English (India)" },
  { code: "hi-IN", label: "Hindi", native: "हिन्दी" },
  { code: "ta-IN", label: "Tamil", native: "தமிழ்" },
  { code: "te-IN", label: "Telugu", native: "తెలుగు" },
  { code: "bn-IN", label: "Bengali", native: "বাংলা" },
  { code: "mr-IN", label: "Marathi", native: "मराठी" },
  { code: "gu-IN", label: "Gujarati", native: "ગુજરાતી" },
  { code: "kn-IN", label: "Kannada", native: "ಕನ್ನಡ" },
  { code: "ml-IN", label: "Malayalam", native: "മലയാളം" },
  { code: "pa-IN", label: "Punjabi", native: "ਪੰਜਾਬੀ" },
];

export const languageByCode = (code: string) => LANGUAGES.find(l => l.code === code) ?? LANGUAGES[0];
/** What Aria says when the caller goes quiet: a check-in, then a goodbye. */
const SILENCE_LINES: Record<string, { check: string; goodbye: string }> = {
  "en-IN": { check: "Are you still there? Take your time, I'm listening.", goodbye: "I haven't heard from you, so I'll end the call now. Please call again anytime. Goodbye!" },
  "hi-IN": { check: "क्या आप अभी भी लाइन पर हैं? आराम से बोलिए, मैं सुन रही हूँ।", goodbye: "मुझे आपकी आवाज़ नहीं आ रही, इसलिए मैं अभी कॉल समाप्त कर रही हूँ। कभी भी दोबारा कॉल करें। धन्यवाद!" },
  "ta-IN": { check: "நீங்கள் இன்னும் லைனில் இருக்கிறீர்களா? நான் கேட்டுக்கொண்டிருக்கிறேன்.", goodbye: "உங்கள் குரல் கேட்கவில்லை, அதனால் அழைப்பை முடிக்கிறேன். எப்போது வேண்டுமானாலும் மீண்டும் அழையுங்கள். நன்றி!" },
  "te-IN": { check: "మీరు ఇంకా లైన్‌లో ఉన్నారా? నేను వింటున్నాను.", goodbye: "మీ మాట వినిపించడం లేదు, కాబట్టి కాల్ ముగిస్తున్నాను. ఎప్పుడైనా మళ్ళీ కాల్ చేయండి. ధన్యవాదాలు!" },
  "bn-IN": { check: "আপনি কি এখনও লাইনে আছেন? আমি শুনছি।", goodbye: "আপনার কথা শুনতে পাচ্ছি না, তাই কলটি শেষ করছি। যেকোনো সময় আবার কল করবেন। ধন্যবাদ!" },
  "mr-IN": { check: "तुम्ही अजून लाइनवर आहात का? मी ऐकत आहे.", goodbye: "तुमचा आवाज येत नाही, म्हणून मी कॉल संपवत आहे. कधीही पुन्हा कॉल करा. धन्यवाद!" },
  "gu-IN": { check: "શું તમે હજી લાઇન પર છો? હું સાંભળી રહી છું.", goodbye: "તમારો અવાજ સંભળાતો નથી, તેથી હું કૉલ પૂરો કરી રહી છું. ગમે ત્યારે ફરી કૉલ કરજો. આભાર!" },
  "kn-IN": { check: "ನೀವು ಇನ್ನೂ ಲೈನ್‌ನಲ್ಲಿದ್ದೀರಾ? ನಾನು ಕೇಳುತ್ತಿದ್ದೇನೆ.", goodbye: "ನಿಮ್ಮ ಧ್ವನಿ ಕೇಳುತ್ತಿಲ್ಲ, ಹಾಗಾಗಿ ಕರೆಯನ್ನು ಮುಗಿಸುತ್ತಿದ್ದೇನೆ. ಯಾವಾಗ ಬೇಕಾದರೂ ಮತ್ತೆ ಕರೆ ಮಾಡಿ. ಧನ್ಯವಾದಗಳು!" },
  "ml-IN": { check: "നിങ്ങൾ ഇപ്പോഴും ലൈനിൽ ഉണ്ടോ? ഞാൻ കേൾക്കുന്നുണ്ട്.", goodbye: "നിങ്ങളുടെ ശബ്ദം കേൾക്കുന്നില്ല, അതിനാൽ ഞാൻ കോൾ അവസാനിപ്പിക്കുന്നു. എപ്പോൾ വേണമെങ്കിലും വീണ്ടും വിളിക്കൂ. നന്ദി!" },
  "pa-IN": { check: "ਕੀ ਤੁਸੀਂ ਅਜੇ ਵੀ ਲਾਈਨ 'ਤੇ ਹੋ? ਮੈਂ ਸੁਣ ਰਹੀ ਹਾਂ।", goodbye: "ਤੁਹਾਡੀ ਆਵਾਜ਼ ਨਹੀਂ ਆ ਰਹੀ, ਇਸ ਲਈ ਮੈਂ ਕਾਲ ਖਤਮ ਕਰ ਰਹੀ ਹਾਂ। ਕਦੇ ਵੀ ਦੁਬਾਰਾ ਕਾਲ ਕਰੋ। ਧੰਨਵਾਦ!" },
};
export const silenceLine = (code: string, kind: "check" | "goodbye") => (SILENCE_LINES[code] ?? SILENCE_LINES["en-IN"])[kind];

/** Aria's greeting for a brand in a call language. */
export const greetingFor = (code: string, brand?: string) => {
  const { greetings } = brandById(brand);
  return greetings[code] ?? greetings["en-IN"];
};

const SCRIPTS: [number, number, string][] = [
  [0x0900, 0x097f, "hi-IN"], // Devanagari (Hindi, Marathi)
  [0x0980, 0x09ff, "bn-IN"],
  [0x0a00, 0x0a7f, "pa-IN"],
  [0x0a80, 0x0aff, "gu-IN"],
  [0x0b00, 0x0b7f, "or-IN"],
  [0x0b80, 0x0bff, "ta-IN"],
  [0x0c00, 0x0c7f, "te-IN"],
  [0x0c80, 0x0cff, "kn-IN"],
  [0x0d00, 0x0d7f, "ml-IN"],
];

/** Language of an Indic-script character, "en-IN" for Latin letters, null for digits and punctuation. */
function charLanguage(char: string, devanagari: string): string | null {
  if (/[A-Za-z]/.test(char)) return "en-IN";
  const code = char.codePointAt(0)!;
  for (const [from, to, lang] of SCRIPTS) if (code >= from && code <= to) return lang === "hi-IN" ? devanagari : lang;
  return null;
}

/** The Indic language a text is written in (by script), or null if it is Latin or has no letters. */
export function detectScriptLanguage(text: string): string | null {
  for (const char of text) {
    const lang = charLanguage(char, "hi-IN");
    if (lang && lang !== "en-IN") return lang;
  }
  return null;
}

// Common Hindi words that rarely appear in English, for spotting Hinglish written in Latin letters.
const HINGLISH = /\b(hai|hain|kya|kahan|kab|kaise|kyun|kyon|mera|meri|mere|mujhe|mujhko|aap|aapka|aapki|nahi|nahin|karna|karo|kijiye|chahiye|tha|thi|raha|rahi|gaya|gayi|hoga|abhi|bhi|wapas|paise|kitna|kitne|batao|bataiye|haan|theek|thik)\b/gi;

// Replies people give in any language; they don't switch the conversation to English.
const NEUTRAL = /^(ok|okay|yes|yeah|no|haan|han|ji|hmm|hi|hello|thanks|bye)$/i;

export function isRomanizedHindi(text: string): boolean {
  return new Set((text.match(HINGLISH) ?? []).map(word => word.toLowerCase())).size >= 2;
}

/**
 * The language Aria should answer in: the language of the customer's latest message that has a
 * clear one (so a typed English question gets English even with Telugu selected), falling back
 * to the language picked in the app for replies like "ok" or a bare order ID.
 */
export function replyLanguage(customerTurns: string[], selected = "en-IN"): string {
  for (const text of [...customerTurns].reverse()) {
    const script = detectScriptLanguage(text);
    if (script) return script === "hi-IN" && selected === "mr-IN" ? "mr-IN" : script;
    if (isRomanizedHindi(text)) return "hi-IN";
    const words = text.replace(/\bORD[-\s]?\d+\b/gi, "").match(/[A-Za-z]{2,}/g) ?? [];
    if (words.some(word => !NEUTRAL.test(word))) return "en-IN";
  }
  return languageByCode(selected).code;
}

export interface Segment {
  text: string;
  lang: string;
}

/** Latin runs this short (an order ID, "COD", "UPI") are read by the neighbouring Indic voice. */
const SHORT_LATIN = 10;
/** Chrome cuts long utterances off after ~15 s, so each is kept to a sentence or two. */
const MAX_SEGMENT = 220;

/**
 * Splits a reply into pieces that each get the right voice: Devanagari goes to the Hindi (or
 * Marathi) voice, Tamil script to the Tamil voice, English to the Indian English voice, and so on.
 * `preferred` decides whether Devanagari is Hindi or Marathi.
 */
export function segmentText(text: string, preferred = "en-IN"): Segment[] {
  const devanagari = preferred === "mr-IN" ? "mr-IN" : "hi-IN";
  let runs: Segment[] = [];
  let pending = "";
  for (const char of text) {
    const lang = charLanguage(char, devanagari);
    const last = runs.at(-1);
    if (lang === null) {
      if (last) last.text += char;
      else pending += char;
    } else if (last && last.lang === lang) last.text += char;
    else runs.push({ text: pending + char, lang }), (pending = "");
  }
  if (!runs.length) return text.trim() ? [{ text: text.trim(), lang: "en-IN" }] : [];

  // Fold short Latin runs into an Indic neighbour so "ORD-101" doesn't switch voices mid-sentence.
  runs = runs.map((run, i) => {
    if (run.lang !== "en-IN" || run.text.replace(/[^A-Za-z]/g, "").length > SHORT_LATIN) return run;
    const neighbour = runs[i - 1]?.lang !== "en-IN" ? runs[i - 1] : runs[i + 1]?.lang !== "en-IN" ? runs[i + 1] : undefined;
    return neighbour ? { ...run, lang: neighbour.lang } : run;
  });
  const merged: Segment[] = [];
  for (const run of runs) {
    const last = merged.at(-1);
    if (last && last.lang === run.lang) last.text += run.text;
    else merged.push({ ...run });
  }

  const out: Segment[] = [];
  for (const segment of merged) {
    let chunk = "";
    for (const sentence of segment.text.split(/(?<=[.!?।॥])\s+/)) {
      if (chunk && chunk.length + sentence.length > MAX_SEGMENT) {
        out.push({ lang: segment.lang, text: chunk.trim() });
        chunk = "";
      }
      chunk += `${sentence} `;
    }
    if (chunk.trim()) out.push({ lang: segment.lang, text: chunk.trim() });
  }
  return out.filter(segment => /[\p{L}\p{N}]/u.test(segment.text));
}
