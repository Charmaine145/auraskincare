import { z } from "zod";
import { checkRateLimit } from "@/lib/rateLimit";
import { readBody } from "@/lib/validation";
import { after } from "next/server";
import { synthesize, TtsError, warmTts } from "@/lib/voice/tts";

export const runtime = "nodejs";
export const maxDuration = 60;

/**
 * Streams Aria's voice from whichever provider answers first (see lib/voice/tts.ts): raw 24 kHz
 * 16-bit mono PCM, which the browser plays chunk by chunk, or MP3 (Edge), which it decodes whole.
 */

const schema = z.object({ text: z.string().trim().min(1).max(1200), voice: z.string().max(60).optional(), language: z.string().regex(/^[a-z]{2}-[A-Z]{2}$/).optional() }).strict();

/** Opens the voice connection for a call that is starting, so the first reply doesn't wait for it. */
export function GET(request: Request) {
  const params = new URL(request.url).searchParams;
  const language = params.get("language") ?? "en-IN";
  after(() => warmTts(/^[a-z]{2}-[A-Z]{2}$/.test(language) ? language : "en-IN", params.get("voice")?.slice(0, 60)));
  return new Response(null, { status: 204 });
}

export async function POST(request: Request) {
  if (!checkRateLimit(request, "tts")) return Response.json({ error: "The voice demo has reached its usage limit for now." }, { status: 429 });
  let input: z.infer<typeof schema>;
  try {
    input = schema.parse(await readBody(request));
  } catch {
    return Response.json({ error: "Invalid voice request." }, { status: 400 });
  }
  try {
    const { provider, format, stream } = await synthesize(input.text, input.voice, AbortSignal.any([request.signal, AbortSignal.timeout(30_000)]), input.language);
    return new Response(stream, {
      headers: { "Content-Type": format === "mp3" ? "audio/mpeg" : "audio/L16; rate=24000; channels=1", "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff", "X-Voice-Provider": provider },
    });
  } catch (error) {
    const status = error instanceof TtsError ? error.status : 502;
    return Response.json({ error: error instanceof TtsError ? error.message : "The premium voice is unavailable right now." }, { status: [429, 503].includes(status) ? status : 502 });
  }
}
