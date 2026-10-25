import { detectScriptLanguage } from "./languages";

/**
 * Text-to-speech providers (server only). Most return a stream of 24 kHz, 16-bit, mono,
 * little-endian PCM; Edge returns MP3, which the browser decodes itself.
 *
 * Providers are tried in order (Edge → Azure → Sarvam → OpenAI → Gemini by default). Edge needs no
 * key and is on unless EDGE_TTS=0; the keyed ones join when ENABLE_PREMIUM_VOICE=1. A provider
 * that runs out of quota is skipped for 10 minutes and the next one answers, so a limit degrades
 * the voice instead of breaking the call. Indian-language text only goes to providers that speak it.
 *
 * Gemini note: the 3.x TTS models read *everything* in the prompt aloud, including style
 * directions, so they only ever receive the line itself plus an en-IN locale.
 */

export const SAMPLE_RATE = 24_000;

export type TtsProviderId = "edge" | "azure" | "sarvam" | "openai" | "gemini";
export type AudioFormat = "pcm" | "mp3";
export interface VoiceOption {
  id: string;
  label: string;
  description: string;
}

export class TtsError extends Error {
  constructor(message: string, readonly status: number) {
    super(message);
  }
}

export interface TtsProvider {
  id: TtsProviderId;
  label: string;
  voices: () => VoiceOption[];
  defaultVoice: () => string;
  configured: () => boolean;
  /** Languages it speaks. The voice picker lists English voices; `voiceFor` picks the others. */
  languages: readonly string[];
  voiceFor?: (language: string) => string | undefined;
  /** PCM unless stated. */
  format?: AudioFormat;
  stream: (text: string, voice: string, signal: AbortSignal, language: string) => Promise<ReadableStream<Uint8Array>>;
}

/** Microsoft's natural female voice for each Indian language: the same voices in Edge and Azure. */
export const MICROSOFT_VOICES: Record<string, string> = {
  "en-IN": "en-IN-NeerjaNeural",
  "hi-IN": "hi-IN-SwaraNeural",
  "ta-IN": "ta-IN-PallaviNeural",
  "te-IN": "te-IN-ShrutiNeural",
  "bn-IN": "bn-IN-TanishaaNeural",
  "mr-IN": "mr-IN-AarohiNeural",
  "gu-IN": "gu-IN-DhwaniNeural",
  "kn-IN": "kn-IN-SapnaNeural",
  "ml-IN": "ml-IN-SobhanaNeural",
};

const SARVAM_LANGUAGES = ["en-IN", "hi-IN", "bn-IN", "ta-IN", "te-IN", "kn-IN", "ml-IN", "mr-IN", "gu-IN", "pa-IN", "od-IN"];

/** The language a line must be spoken in, from its script: Telugu text needs a Telugu voice. */
export function speechLanguage(text: string, preferred?: string): string {
  const script = detectScriptLanguage(text);
  if (!script) return "en-IN";
  return script === "hi-IN" && preferred === "mr-IN" ? "mr-IN" : script;
}

/** "hi-IN-SwaraNeural" → "Swara", "priya" → "Priya". */
const voiceLabel = (id: string) => {
  const name = id.replace(/^[a-z]{2}-[A-Z]{2}-/, "").replace(/Neural$/, "").replace(/Expressive$/, " Expressive");
  return name.charAt(0).toUpperCase() + name.slice(1);
};

const INDIAN_ENGLISH_STYLE = "Speak as a warm, friendly customer care specialist from India, with a natural Indian English accent and an easy, conversational pace.";

// ------------------------------------------------------------------ helpers

const escapeXml = (text: string) => text.replace(/[<>&'"]/g, c => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;", "'": "&apos;", '"': "&quot;" })[c]!);

/** Returns the samples inside a WAV file, however many chunks precede "data". */
export function wavToPcm(wav: Buffer): Buffer {
  if (wav.length < 12 || wav.toString("latin1", 0, 4) !== "RIFF") return wav;
  let offset = 12;
  while (offset + 8 <= wav.length) {
    const id = wav.toString("latin1", offset, offset + 4);
    const size = wav.readUInt32LE(offset + 4);
    if (id === "data") return wav.subarray(offset + 8, Math.min(wav.length, offset + 8 + size));
    offset += 8 + size + (size % 2);
  }
  return Buffer.alloc(0);
}

/** Emits a finished buffer as a stream, in small chunks so playback can begin immediately. */
function bufferStream(pcm: Buffer): ReadableStream<Uint8Array> {
  let offset = 0;
  return new ReadableStream({
    pull(controller) {
      if (offset >= pcm.length) return controller.close();
      const end = Math.min(pcm.length, offset + 9600);
      controller.enqueue(new Uint8Array(pcm.subarray(offset, end)));
      offset = end;
    },
  });
}

async function failure(provider: string, response: Response): Promise<never> {
  if (process.env.ARIA_PROVIDER_DEBUG === "1") console.error(provider, "TTS", response.status, (await response.text().catch(() => "")).slice(0, 500));
  throw new TtsError(`${provider} voice failed (${response.status})`, response.status);
}

const pick = (voices: VoiceOption[], preferred: string | undefined, fallback: string) =>
  preferred && voices.some(v => v.id === preferred) ? preferred : fallback;

// ------------------------------------------------------------------ Microsoft Edge (Read Aloud)

const EDGE_TIMEOUT_MS = 8000;
/** A warm reply takes ~0.4 s. On serverless, a connection kept across a freeze can look open but be dead, so it gets this long before a fresh one is tried. */
const EDGE_REUSE_MS = 3000;

type EdgeClient = import("msedge-tts").MsEdgeTTS;

/**
 * One open connection per voice. Opening one costs ~500 ms (token + WebSocket handshake), more
 * than the synthesis itself, so connections are kept and reused; a broken one is replaced.
 */
// Kept on globalThis: Next.js may load this module once per route, and the connection warmed by
// /api/config must be the one /api/tts-stream uses (it also survives dev hot reloads).
const edgeScope = globalThis as typeof globalThis & { ariaEdgeClients?: Map<string, Promise<EdgeClient>>; ariaEdgeUsed?: Map<string, number> };
const edgeClients = (edgeScope.ariaEdgeClients ??= new Map<string, Promise<EdgeClient>>());
const edgeUsed = (edgeScope.ariaEdgeUsed ??= new Map<string, number>());
/** The service drops idle connections after about a minute; reusing one then costs a reconnect. */
const EDGE_IDLE_MS = 40_000;

function edgeClient(voice: string): Promise<EdgeClient> {
  edgeUsed.set(voice, Date.now());
  let client = edgeClients.get(voice);
  if (!client) {
    client = (async () => {
      const { MsEdgeTTS, OUTPUT_FORMAT } = await import("msedge-tts");
      const tts = new MsEdgeTTS();
      await tts.setMetadata(voice, OUTPUT_FORMAT.AUDIO_24KHZ_48KBITRATE_MONO_MP3);
      return tts;
    })();
    edgeClients.set(voice, client);
    client.catch(() => edgeClients.delete(voice));
  }
  return client;
}

function dropEdgeClient(voice: string) {
  const client = edgeClients.get(voice);
  edgeClients.delete(voice);
  void client?.then(tts => tts.close()).catch(() => {});
}

async function edgeSynthesize(text: string, voice: string, signal: AbortSignal): Promise<Buffer> {
  const tts = await edgeClient(voice);
  // The library pastes the text straight into its SSML, so it has to be escaped here.
  const { audioStream } = tts.toStream(escapeXml(text));
  const chunks: Buffer[] = [];
  await new Promise<void>((resolve, reject) => {
    audioStream.on("data", (chunk: Buffer) => chunks.push(chunk));
    audioStream.on("end", () => resolve());
    audioStream.on("error", reject);
    signal.addEventListener("abort", () => reject(signal.reason), { once: true });
  });
  return Buffer.concat(chunks);
}

/**
 * Opens (or reopens, if it has gone idle) the connection for a call's voice ahead of the first
 * reply, so the caller never waits for the handshake. Called on page load and when a call starts.
 */
export async function warmTts(language = "en-IN", voice?: string): Promise<void> {
  const primary = ttsProviders()[0];
  if (primary?.id !== "edge") return;
  const id = language === "en-IN" ? pick(primary.voices(), voice, primary.defaultVoice()) : primary.voiceFor?.(language);
  if (!id || Date.now() - (edgeUsed.get(id) ?? 0) < EDGE_IDLE_MS) return;
  // The library only (re)connects when it synthesises, so a one-word line does the handshake now.
  await edgeSynthesize("Hi.", id, AbortSignal.timeout(EDGE_REUSE_MS)).catch(() => dropEdgeClient(id));
}

/**
 * The free service behind Edge's Read Aloud: Microsoft's natural Indian voices, no key and no
 * published quota. It is unofficial, so it is time-limited and any failure falls through to the
 * next provider (or the browser's own voice). It only returns MP3, which the browser decodes.
 */
const edge: TtsProvider = {
  id: "edge",
  label: "Edge natural voice",
  voices: () => [
    { id: "en-IN-NeerjaNeural", label: "Neerja", description: "Warm Indian English" },
    { id: "en-IN-NeerjaExpressiveNeural", label: "Neerja Expressive", description: "Livelier and more animated" },
  ],
  defaultVoice: () => process.env.EDGE_TTS_VOICE || "en-IN-NeerjaNeural",
  configured: () => process.env.EDGE_TTS !== "0",
  languages: Object.keys(MICROSOFT_VOICES),
  voiceFor: language => MICROSOFT_VOICES[language],
  format: "mp3",
  async stream(text, voice, signal) {
    const total = AbortSignal.any([signal, AbortSignal.timeout(EDGE_TIMEOUT_MS)]);
    // The kept connection first, briefly; then once more on a fresh connection with the time left.
    for (const budget of [EDGE_REUSE_MS, EDGE_TIMEOUT_MS]) {
      try {
        const mp3 = await edgeSynthesize(text, voice, AbortSignal.any([total, AbortSignal.timeout(budget)]));
        if (mp3.length) return bufferStream(mp3);
      } catch (error) {
        if (signal.aborted) throw error;
        if (process.env.ARIA_PROVIDER_DEBUG === "1") console.error("Edge TTS", error);
        if (total.aborted) break;
      }
      dropEdgeClient(voice);
    }
    throw new TtsError("Edge voice failed", 502);
  },
};

// ------------------------------------------------------------------ Azure AI Speech

const azure: TtsProvider = {
  id: "azure",
  label: "Azure Neural voice",
  voices: () => [
    { id: "en-IN-NeerjaNeural", label: "Neerja", description: "Warm Indian English" },
    { id: "en-IN-AnanyaNeural", label: "Ananya", description: "Bright and friendly" },
    { id: "en-IN-KavyaNeural", label: "Kavya", description: "Soft and calm" },
  ],
  defaultVoice: () => process.env.AZURE_TTS_VOICE || "en-IN-NeerjaNeural",
  configured: () => Boolean(process.env.AZURE_SPEECH_KEY),
  languages: Object.keys(MICROSOFT_VOICES),
  voiceFor: language => MICROSOFT_VOICES[language],
  async stream(text, voice, signal, language) {
    const region = process.env.AZURE_SPEECH_REGION || "centralindia";
    const response = await fetch(`https://${region}.tts.speech.microsoft.com/cognitiveservices/v1`, {
      method: "POST",
      headers: {
        "Ocp-Apim-Subscription-Key": process.env.AZURE_SPEECH_KEY!,
        "Content-Type": "application/ssml+xml",
        "X-Microsoft-OutputFormat": "raw-24khz-16bit-mono-pcm",
        "User-Agent": "aura-aria",
      },
      body: `<speak version="1.0" xml:lang="${language}"><voice name="${escapeXml(voice)}">${escapeXml(text)}</voice></speak>`,
      signal,
    });
    if (!response.ok || !response.body) return failure("Azure", response);
    return response.body;
  },
};

// ------------------------------------------------------------------ Sarvam AI (Bulbul)

const sarvamModel = () => process.env.SARVAM_TTS_MODEL || "bulbul:v3";
const sarvam: TtsProvider = {
  id: "sarvam",
  label: "Sarvam Bulbul voice",
  voices: () =>
    sarvamModel().includes("v3")
      ? [
          { id: "priya", label: "Priya", description: "Warm Indian English" },
          { id: "simran", label: "Simran", description: "Bright and friendly" },
          { id: "ishita", label: "Ishita", description: "Soft and calm" },
        ]
      : [
          { id: "anushka", label: "Anushka", description: "Warm Indian English" },
          { id: "manisha", label: "Manisha", description: "Bright and friendly" },
          { id: "vidya", label: "Vidya", description: "Soft and calm" },
        ],
  defaultVoice: () => process.env.SARVAM_TTS_SPEAKER || sarvam.voices()[0].id,
  configured: () => Boolean(process.env.SARVAM_API_KEY),
  languages: SARVAM_LANGUAGES,
  async stream(text, voice, signal, language) {
    // The docs have used both field names for the language; try the current one, then the other.
    const request = (languageField: string) =>
      fetch("https://api.sarvam.ai/text-to-speech", {
        method: "POST",
        headers: { "api-subscription-key": process.env.SARVAM_API_KEY!, "Content-Type": "application/json" },
        body: JSON.stringify({ text, [languageField]: language, speaker: voice, model: sarvamModel(), speech_sample_rate: SAMPLE_RATE }),
        signal,
      });
    let response = await request("target_language_code");
    if (response.status === 400 || response.status === 422) response = await request("language_code");
    if (!response.ok) return failure("Sarvam", response);
    const data = (await response.json()) as { audios?: string[] };
    if (!data.audios?.[0]) throw new TtsError("Sarvam returned no audio", 502);
    return bufferStream(wavToPcm(Buffer.from(data.audios[0], "base64")));
  },
};

// ------------------------------------------------------------------ OpenAI

const openAiModel = () => process.env.OPENAI_TTS_MODEL || "gpt-4o-mini-tts";
const openai: TtsProvider = {
  id: "openai",
  label: "OpenAI voice",
  voices: () => [
    { id: "coral", label: "Coral", description: "Warm and clear" },
    { id: "shimmer", label: "Shimmer", description: "Bright and friendly" },
    { id: "sage", label: "Sage", description: "Soft and calm" },
  ],
  defaultVoice: () => process.env.OPENAI_TTS_VOICE || "coral",
  configured: () => Boolean(process.env.OPENAI_API_KEY),
  languages: ["en-IN"],
  async stream(text, voice, signal) {
    const model = openAiModel();
    const response = await fetch("https://api.openai.com/v1/audio/speech", {
      method: "POST",
      headers: { Authorization: `Bearer ${process.env.OPENAI_API_KEY}`, "Content-Type": "application/json" },
      // "pcm" is raw 24 kHz 16-bit mono. gpt-4o-mini-tts takes separate style instructions (never read aloud).
      body: JSON.stringify({ model, voice, input: text, response_format: "pcm", ...(model.startsWith("gpt-4o") ? { instructions: INDIAN_ENGLISH_STYLE } : {}) }),
      signal,
    });
    if (!response.ok || !response.body) return failure("OpenAI", response);
    return response.body;
  },
};

// ------------------------------------------------------------------ Gemini

const geminiModels = () => {
  const fallbacks = (process.env.GEMINI_TTS_FALLBACK_MODELS ?? "gemini-3.8-flash-tts").split(",").map(m => m.trim()).filter(Boolean);
  return [...new Set([process.env.GEMINI_TTS_MODEL || "gemini-3.8-flash-lite-tts", ...fallbacks])];
};

export function geminiRequestBody(model: string, text: string, voice: string) {
  // 2.5 models follow a spoken direction; 3.x models would read it aloud, so they get a locale instead.
  const directed = model.startsWith("gemini-2.5");
  return {
    contents: [{ parts: [{ text: directed ? `Say in a warm, friendly Indian English accent, at an easy conversational pace: ${text}` : text }] }],
    generationConfig: {
      responseModalities: ["AUDIO"],
      speechConfig: { ...(directed ? {} : { languageCode: "en-IN" }), voiceConfig: { prebuiltVoiceConfig: { voiceName: voice } } },
    },
  };
}

/** Converts Gemini's server-sent events into raw PCM, removing any per-chunk WAV header. */
function geminiEventsToPcm(body: ReadableStream<Uint8Array>): ReadableStream<Uint8Array> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let pending = "";
  return new ReadableStream({
    async pull(controller) {
      while (true) {
        const end = pending.indexOf("\n\n");
        if (end !== -1) {
          const event = pending.slice(0, end);
          pending = pending.slice(end + 2);
          const line = event.split("\n").find(l => l.startsWith("data: "));
          if (!line) continue;
          const parts: { inlineData?: { data: string } }[] = JSON.parse(line.slice(6)).candidates?.[0]?.content?.parts ?? [];
          let emitted = false;
          for (const part of parts) {
            if (!part.inlineData?.data) continue;
            const pcm = wavToPcm(Buffer.from(part.inlineData.data, "base64"));
            if (pcm.length) {
              controller.enqueue(new Uint8Array(pcm));
              emitted = true;
            }
          }
          if (emitted) return;
          continue;
        }
        const { value, done } = await reader.read();
        if (done) return controller.close();
        pending = (pending + decoder.decode(value, { stream: true })).replace(/\r\n/g, "\n");
      }
    },
    cancel() {
      void reader.cancel().catch(() => {});
    },
  });
}

const gemini: TtsProvider = {
  id: "gemini",
  label: "Gemini voice",
  voices: () => [
    { id: "Aoede", label: "Aoede", description: "Friendly and bright" },
    { id: "Sulafat", label: "Sulafat", description: "Warm and reassuring" },
    { id: "Leda", label: "Leda", description: "Light and cheerful" },
  ],
  defaultVoice: () => process.env.GEMINI_TTS_VOICE || "Aoede",
  configured: () => Boolean(process.env.GEMINI_API_KEY),
  languages: ["en-IN"],
  async stream(text, voice, signal) {
    let last = 502;
    for (const model of geminiModels().filter(m => !isExhausted(`gemini:${m}`))) {
      const streaming = /^gemini-(3\.[1-9]|[4-9])/.test(model);
      const response = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:${streaming ? "streamGenerateContent?alt=sse" : "generateContent"}`, {
        method: "POST",
        headers: { "x-goog-api-key": process.env.GEMINI_API_KEY!, "Content-Type": "application/json" },
        body: JSON.stringify(geminiRequestBody(model, text, voice)),
        signal,
      });
      if (!response.ok || !response.body) {
        last = response.status;
        if (response.status === 429) markExhausted(`gemini:${model}`);
        if ([429, 500, 503, 504].includes(response.status)) continue;
        return failure("Gemini", response);
      }
      if (streaming) return geminiEventsToPcm(response.body);
      const data = await response.json();
      const inline = data.candidates?.[0]?.content?.parts?.find((p: { inlineData?: { data: string } }) => p.inlineData?.data)?.inlineData;
      if (!inline) throw new TtsError("Gemini returned no audio", 502);
      return bufferStream(wavToPcm(Buffer.from(inline.data, "base64")));
    }
    throw new TtsError("Gemini voice is out of quota", last === 502 ? 429 : last);
  },
};

// ------------------------------------------------------------------ provider chain

const PROVIDERS = [edge, azure, sarvam, openai, gemini];
const EXHAUSTED_MS = 10 * 60 * 1000;
const exhausted = new Map<string, number>();
export const markExhausted = (key: string) => exhausted.set(key, Date.now() + EXHAUSTED_MS);
const isExhausted = (key: string) => (exhausted.get(key) ?? 0) > Date.now();
export const resetTtsState = () => exhausted.clear();

/**
 * Edge's free voices are on by default. Keyed providers are opt-in (ENABLE_PREMIUM_VOICE=1) because
 * their keys may be shared with the chat model and spend its quota. With none, Aria uses the
 * browser's own voices. Configured providers, the preferred one (TTS_PROVIDER) first, recently
 * exhausted ones last.
 */
export function ttsProviders(): TtsProvider[] {
  const keyed = process.env.ENABLE_PREMIUM_VOICE === "1";
  const configured = PROVIDERS.filter(p => p.configured() && (p.id === "edge" || keyed));
  const preferred = process.env.TTS_PROVIDER;
  const ordered = preferred ? [...configured.filter(p => p.id === preferred), ...configured.filter(p => p.id !== preferred)] : configured;
  return [...ordered.filter(p => !isExhausted(p.id)), ...ordered.filter(p => isExhausted(p.id))];
}

export function voiceInfo() {
  const providers = ttsProviders();
  const primary = providers[0];
  if (!primary) return { voiceProvider: null, voices: [] as VoiceOption[], defaultVoice: null, voiceLanguages: {} as Record<string, string> };
  // Which voice would read each Indian language, from the first provider that speaks it.
  const voiceLanguages: Record<string, string> = {};
  for (const provider of providers) {
    for (const language of provider.languages) {
      if (language === "en-IN" || voiceLanguages[language]) continue;
      voiceLanguages[language] = voiceLabel(provider.voiceFor?.(language) ?? provider.defaultVoice());
    }
  }
  return { voiceProvider: primary.id, voices: primary.voices(), defaultVoice: pick(primary.voices(), primary.defaultVoice(), primary.voices()[0].id), voiceLanguages };
}

export interface Synthesis {
  provider: TtsProviderId;
  format: AudioFormat;
  stream: ReadableStream<Uint8Array>;
}

/**
 * Synthesises `text` in the language of its script, falling through providers on quota, auth or
 * server errors. `preferred` is the call language, which tells Marathi from Hindi (both Devanagari).
 */
export async function synthesize(text: string, voice: string | undefined, signal: AbortSignal, preferred?: string): Promise<Synthesis> {
  const language = speechLanguage(text, preferred);
  const configured = ttsProviders();
  if (!configured.length) throw new TtsError("No premium voice is configured.", 503);
  const providers = configured.filter(p => p.languages.includes(language));
  // Not 503: the premium voice still works for English, so the call shouldn't give up on it.
  if (!providers.length) throw new TtsError(`No premium voice speaks ${language}.`, 422);
  let lastStatus = 502;
  for (const [index, provider] of providers.entries()) {
    // The requested voice is an English voice of the primary provider; fallbacks use their own default.
    const chosen = language === "en-IN"
      ? pick(provider.voices(), index === 0 && provider === configured[0] ? voice : undefined, provider.defaultVoice())
      : provider.voiceFor?.(language) ?? provider.defaultVoice();
    try {
      return { provider: provider.id, format: provider.format ?? "pcm", stream: await provider.stream(text, chosen, signal, language) };
    } catch (error) {
      if (signal.aborted) throw error;
      lastStatus = error instanceof TtsError ? error.status : 502;
      if (lastStatus === 429) markExhausted(provider.id);
    }
  }
  throw new TtsError(lastStatus === 429 ? "Every premium voice is out of quota right now." : "The premium voice is unavailable right now.", lastStatus === 429 ? 429 : 502);
}

export async function readAll(stream: ReadableStream<Uint8Array>): Promise<Buffer> {
  const chunks: Buffer[] = [];
  const reader = stream.getReader();
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    chunks.push(Buffer.from(value));
  }
  return Buffer.concat(chunks);
}
