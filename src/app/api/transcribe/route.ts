import { checkRateLimit } from "@/lib/rateLimit";

export const runtime = "nodejs";
export const maxDuration = 60;

/**
 * Server speech-to-text for browsers without the Web Speech API (e.g. Firefox), or when the
 * caller picks "Gemini" in settings. The recording is processed in memory and never stored.
 */

const ACCEPTED = new Set(["audio/webm", "audio/ogg", "audio/mp4", "audio/wav", "audio/mpeg"]);
const INSTRUCTION = "Transcribe only the customer's spoken words in the language they spoke, written in that language's own script (Devanagari for Hindi, and so on). Write order IDs like ORD-101. Return nothing else. If there is no intelligible speech, return an empty string.";

export async function POST(request: Request) {
  if (!checkRateLimit(request, "transcription")) return Response.json({ error: "The voice demo has reached its usage limit for now." }, { status: 429 });
  const key = process.env.GEMINI_API_KEY;
  if (!key) return Response.json({ error: "Cloud transcription needs a Gemini API key. Please type your question instead." }, { status: 503 });

  try {
    const form = await request.formData();
    const file = form.get("audio");
    const type = file instanceof File ? file.type.split(";")[0] : "";
    if (!(file instanceof File) || !ACCEPTED.has(type) || file.size < 1000 || file.size > 3_000_000) {
      return Response.json({ error: "Please record a short, clear question and try again." }, { status: 400 });
    }
    const data = Buffer.from(await file.arrayBuffer()).toString("base64");
    const models = [...new Set([process.env.GEMINI_STT_MODEL || "gemini-3.1-flash-lite", process.env.GEMINI_MODEL || "gemini-3.5-flash-lite"])];

    let response: Response | undefined;
    for (const model of models) {
      response = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`, {
        method: "POST",
        headers: { "x-goog-api-key": key, "Content-Type": "application/json" },
        body: JSON.stringify({
          contents: [{ parts: [{ inlineData: { mimeType: type, data } }, { text: INSTRUCTION }] }],
          generationConfig: { maxOutputTokens: 300, temperature: 0, ...(model.includes("transcribe") ? {} : { thinkingConfig: model.startsWith("gemini-2.5") ? { thinkingBudget: 0 } : { thinkingLevel: "LOW" } }) },
        }),
        signal: AbortSignal.any([request.signal, AbortSignal.timeout(25_000)]),
      });
      if (response.ok || ![429, 500, 503].includes(response.status)) break;
    }
    if (!response?.ok) {
      return Response.json({ error: response?.status === 403 ? "The transcription key was rejected. Please type your question." : "Voice transcription is temporarily unavailable. Please type your question." }, { status: 502 });
    }
    const result = await response.json();
    const text = String(result.candidates?.[0]?.content?.parts?.filter((p: { text?: string }) => p.text).map((p: { text: string }) => p.text).join("") ?? "").trim().slice(0, 2000);
    if (!text || /^\s*[<[(]?(noise|silence|no speech|inaudible|music|empty|blank)[>\])]?\s*[.!]?$|^(""|'')$/i.test(text)) {
      return Response.json({ error: "I couldn't hear you clearly. Please repeat that." }, { status: 422 });
    }
    return Response.json({ text });
  } catch {
    return Response.json({ error: "Voice transcription failed. Please try again or type your question." }, { status: 502 });
  }
}
