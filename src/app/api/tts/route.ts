import { createHash } from "node:crypto";
import { z } from "zod";
import { pcmToWav } from "@/lib/audio";
import { checkRateLimit } from "@/lib/rateLimit";
import { readBody } from "@/lib/validation";
import { readAll, SAMPLE_RATE, synthesize, TtsError } from "@/lib/voice/tts";

export const runtime = "nodejs";
export const maxDuration = 60;

/**
 * Whole-clip text-to-speech as WAV (or MP3 from Edge). Used for the greeting and "let me check" clips when no
 * pre-recorded file exists for the current voice; results are cached so each clip costs one request.
 */

const schema = z.object({ text: z.string().trim().min(1).max(600), voice: z.string().max(60).optional(), language: z.string().regex(/^[a-z]{2}-[A-Z]{2}$/).optional() }).strict();
const CACHE_LIMIT_BYTES = 12_000_000;
const cache = new Map<string, { audio: Buffer; type: string; provider: string }>();
let cacheBytes = 0;

function remember(key: string, clip: { audio: Buffer; type: string; provider: string }) {
  while (cache.size && cacheBytes + clip.audio.length > CACHE_LIMIT_BYTES) {
    const oldest = cache.keys().next().value!;
    cacheBytes -= cache.get(oldest)!.audio.length;
    cache.delete(oldest);
  }
  cache.set(key, clip);
  cacheBytes += clip.audio.length;
}

const respond = ({ audio, type, provider }: { audio: Buffer; type: string; provider: string }) =>
  new Response(new Uint8Array(audio), { headers: { "Content-Type": type, "Cache-Control": "no-store", "X-Voice-Provider": provider } });

export async function POST(request: Request) {
  if (!checkRateLimit(request, "tts")) return Response.json({ error: "The voice demo has reached its usage limit for now." }, { status: 429 });
  let input: z.infer<typeof schema>;
  try {
    input = schema.parse(await readBody(request));
  } catch {
    return Response.json({ error: "Invalid voice request." }, { status: 400 });
  }
  const key = createHash("sha256").update(JSON.stringify([input.voice ?? "", input.language ?? "", input.text])).digest("hex");
  const saved = cache.get(key);
  if (saved) return respond(saved);
  try {
    const { provider, format, stream } = await synthesize(input.text, input.voice, AbortSignal.any([request.signal, AbortSignal.timeout(45_000)]), input.language);
    const bytes = await readAll(stream);
    if (bytes.length < 2) throw new TtsError("No audio returned", 502);
    const clip = format === "mp3"
      ? { audio: bytes, type: "audio/mpeg", provider }
      : { audio: pcmToWav(bytes.subarray(0, bytes.length - (bytes.length % 2)), SAMPLE_RATE), type: "audio/wav", provider };
    remember(key, clip);
    return respond(clip);
  } catch (error) {
    const status = error instanceof TtsError ? error.status : 502;
    return Response.json({ error: error instanceof TtsError ? error.message : "The premium voice is unavailable right now." }, { status: [429, 503].includes(status) ? status : 502 });
  }
}
