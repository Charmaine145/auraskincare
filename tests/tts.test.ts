import { test } from "node:test";
import assert from "node:assert/strict";
import { POST as speakWhole } from "../src/app/api/tts/route";
import { POST as streamVoice } from "../src/app/api/tts-stream/route";
import { pcmToWav } from "../src/lib/audio";
import { readAll, resetTtsState, speechLanguage, synthesize, ttsProviders, voiceInfo, wavToPcm } from "../src/lib/voice/tts";
import { withEnv, withFetch } from "./helpers";

const NONE = { EDGE_TTS: "0", ENABLE_PREMIUM_VOICE: "1", AZURE_SPEECH_KEY: undefined, SARVAM_API_KEY: undefined, OPENAI_API_KEY: undefined, GEMINI_API_KEY: undefined, TTS_PROVIDER: undefined };
const PCM = Buffer.from([1, 0, 2, 0, 3, 0, 4, 0]);
const signal = () => AbortSignal.timeout(5000);
const post = (url: string, body: unknown) => new Request(url, { method: "POST", headers: { "x-vercel-forwarded-for": crypto.randomUUID() }, body: JSON.stringify(body) });

/** A WAV with an extra LIST chunk before "data", like some encoders produce. */
function wavWithList(pcm: Buffer) {
  const list = Buffer.concat([Buffer.from("LIST"), Buffer.from([4, 0, 0, 0]), Buffer.from("INFO")]);
  const wav = pcmToWav(pcm);
  return Buffer.concat([wav.subarray(0, 36), list, wav.subarray(36)]);
}

test("WAV parsing finds the data chunk, whatever precedes it", () => {
  assert.deepEqual(wavToPcm(pcmToWav(PCM)), PCM);
  assert.deepEqual(wavToPcm(wavWithList(PCM)), PCM);
  assert.deepEqual(wavToPcm(PCM), PCM, "raw PCM passes through");
});

test("providers are ordered Azure → Sarvam → OpenAI → Gemini, or by TTS_PROVIDER", () =>
  withEnv({ ...NONE, AZURE_SPEECH_KEY: "a", GEMINI_API_KEY: "g", SARVAM_API_KEY: "s" }, () => {
    resetTtsState();
    assert.deepEqual(ttsProviders().map(p => p.id), ["azure", "sarvam", "gemini"]);
    process.env.TTS_PROVIDER = "gemini";
    assert.deepEqual(ttsProviders().map(p => p.id), ["gemini", "azure", "sarvam"]);
    assert.equal(voiceInfo().voiceProvider, "gemini");
  }));

test("Azure: SSML with an Indian English voice, escaped text, raw 24 kHz PCM", () =>
  withEnv({ ...NONE, AZURE_SPEECH_KEY: "key", AZURE_SPEECH_REGION: "centralindia" }, () =>
    withFetch(
      () => new Response(PCM),
      async calls => {
        resetTtsState();
        const { provider, stream } = await synthesize("Returns & refunds <7 days>", "en-IN-KavyaNeural", signal());
        assert.equal(provider, "azure");
        assert.deepEqual(await readAll(stream), PCM);
        assert.equal(calls[0].url, "https://centralindia.tts.speech.microsoft.com/cognitiveservices/v1");
        assert.match(String(calls[0].body), /<voice name="en-IN-KavyaNeural">Returns &amp; refunds &lt;7 days&gt;<\/voice>/);
      },
    )));

test("Sarvam: retries with the other language field name and unwraps the WAV", () =>
  withEnv({ ...NONE, SARVAM_API_KEY: "key" }, () =>
    withFetch(
      (_url, _body, index) => (index === 0 ? new Response("{}", { status: 422 }) : Response.json({ audios: [wavWithList(PCM).toString("base64")] })),
      async calls => {
        resetTtsState();
        const { provider, stream } = await synthesize("Hello", "anushka", signal());
        assert.equal(provider, "sarvam");
        assert.deepEqual(await readAll(stream), PCM);
        assert.equal(calls[0].body.target_language_code, "en-IN");
        assert.equal(calls[1].body.language_code, "en-IN");
        assert.equal(calls[1].body.speech_sample_rate, 24000);
      },
    )));

test("OpenAI: raw PCM with accent instructions sent separately from the text", () =>
  withEnv({ ...NONE, OPENAI_API_KEY: "key", OPENAI_TTS_MODEL: undefined }, () =>
    withFetch(
      () => new Response(PCM),
      async calls => {
        resetTtsState();
        await readAll((await synthesize("Hello", "coral", signal())).stream);
        assert.equal(calls[0].body.response_format, "pcm");
        assert.equal(calls[0].body.input, "Hello");
        assert.match(calls[0].body.instructions, /Indian English accent/);
      },
    )));

test("Gemini 3.x: only the line is sent, SSE audio becomes PCM with WAV headers removed", () =>
  withEnv({ ...NONE, GEMINI_API_KEY: "key", GEMINI_TTS_MODEL: "gemini-3.8-flash-lite-tts" }, () => {
    const events = [PCM.subarray(0, 4), PCM.subarray(4)]
      .map(part => `data: ${JSON.stringify({ candidates: [{ content: { parts: [{ inlineData: { mimeType: "audio/wav", data: pcmToWav(Buffer.from(part)).toString("base64") } }] } }] })}\r\n\r\n`)
      .join("");
    return withFetch(
      () => new Response(new ReadableStream({ start(c) { const bytes = new TextEncoder().encode(events); c.enqueue(bytes.subarray(0, 50)); c.enqueue(bytes.subarray(50)); c.close(); } })),
      async calls => {
        resetTtsState();
        const { stream } = await synthesize("Hello", "Aoede", signal());
        assert.deepEqual(await readAll(stream), PCM);
        assert.equal(calls[0].body.contents[0].parts[0].text, "Hello", "3.x models read every word aloud, so no directions");
        assert.equal(calls[0].body.generationConfig.speechConfig.languageCode, "en-IN");
      },
    );
  }));

test("a provider out of quota hands over to the next, and is skipped afterwards", () =>
  withEnv({ ...NONE, AZURE_SPEECH_KEY: "a", OPENAI_API_KEY: "o" }, () =>
    withFetch(
      url => (url.includes("microsoft") ? new Response("{}", { status: 429 }) : new Response(PCM)),
      async calls => {
        resetTtsState();
        const first = await synthesize("Hello", "en-IN-NeerjaNeural", signal());
        assert.equal(first.provider, "openai");
        assert.equal(calls[1].body.voice, "coral", "the fallback uses its own default voice");
        await synthesize("Again", undefined, signal());
        assert.equal(calls.length, 3, "the exhausted provider isn't retried straight away");
        assert.deepEqual(ttsProviders().map(p => p.id), ["openai", "azure"]);
      },
    )));

test("/api/tts-stream streams PCM and names the provider; /api/tts returns a cached WAV", () =>
  withEnv({ ...NONE, AZURE_SPEECH_KEY: "key" }, () =>
    withFetch(
      () => new Response(PCM),
      async calls => {
        resetTtsState();
        const streamed = await streamVoice(post("http://localhost/api/tts-stream", { text: "Hello", voice: "en-IN-NeerjaNeural" }));
        assert.equal(streamed.headers.get("X-Voice-Provider"), "azure");
        assert.deepEqual(Buffer.from(await streamed.arrayBuffer()), PCM);

        const whole = await speakWhole(post("http://localhost/api/tts", { text: "Sure, let me check.", voice: "en-IN-NeerjaNeural" }));
        const wav = Buffer.from(await whole.arrayBuffer());
        assert.equal(wav.toString("ascii", 0, 4), "RIFF");
        assert.deepEqual(wavToPcm(wav), PCM);
        await speakWhole(post("http://localhost/api/tts", { text: "Sure, let me check.", voice: "en-IN-NeerjaNeural" }));
        assert.equal(calls.length, 2, "the second identical clip is served from cache");
      },
    )));

test("with no provider configured the browser voice is used", () =>
  withEnv(NONE, async () => {
    resetTtsState();
    assert.equal(voiceInfo().voiceProvider, null);
    assert.equal((await streamVoice(post("http://localhost/api/tts-stream", { text: "Hello" }))).status, 503);
  }));

test("Edge's free voices are on without any key; keyed providers still need ENABLE_PREMIUM_VOICE", () =>
  withEnv({ ...NONE, EDGE_TTS: undefined, ENABLE_PREMIUM_VOICE: undefined, SARVAM_API_KEY: "s", GEMINI_API_KEY: "g" }, () => {
    resetTtsState();
    assert.deepEqual(ttsProviders().map(p => p.id), ["edge"]);
    process.env.ENABLE_PREMIUM_VOICE = "1";
    assert.deepEqual(ttsProviders().map(p => p.id), ["edge", "sarvam", "gemini"], "Sarvam backs Edge up");
    const info = voiceInfo();
    assert.equal(info.voiceProvider, "edge");
    assert.equal(info.defaultVoice, "en-IN-NeerjaNeural");
    assert.equal(info.voiceLanguages["te-IN"], "Shruti");
    assert.equal(info.voiceLanguages["pa-IN"], "Priya", "Punjabi has no Microsoft voice, so Sarvam covers it");
  }));

test("the speaking language comes from the script; Devanagari is Marathi only in a Marathi call", () => {
  assert.equal(speechLanguage("Your order ORD-101 is on its way."), "en-IN");
  assert.equal(speechLanguage("ORD-101 ఈ రోజు వస్తుంది"), "te-IN");
  assert.equal(speechLanguage("आपका ऑर्डर आ रहा है", "en-IN"), "hi-IN");
  assert.equal(speechLanguage("तुमची ऑर्डर येत आहे", "mr-IN"), "mr-IN");
});

test("Indian-language lines skip English-only providers and get a voice for that language", () =>
  withEnv({ ...NONE, AZURE_SPEECH_KEY: "a", SARVAM_API_KEY: "s", GEMINI_API_KEY: "g", TTS_PROVIDER: "gemini" }, () =>
    withFetch(
      url => (url.includes("microsoft") ? new Response("{}", { status: 500 }) : Response.json({ audios: [pcmToWav(PCM).toString("base64")] })),
      async calls => {
        resetTtsState();
        const { provider } = await synthesize("మీ ఆర్డర్ వస్తోంది", "Aoede", signal());
        assert.equal(provider, "sarvam");
        assert.equal(calls.length, 2, "Gemini, though preferred, never gets Telugu");
        assert.match(String(calls[0].body), /<speak version="1.0" xml:lang="te-IN"><voice name="te-IN-ShrutiNeural">/);
        assert.equal(calls[1].body.target_language_code, "te-IN");
        assert.equal(calls[1].body.speaker, "priya", "the fallback uses its own voice, not Gemini's");
      },
    )));

test("a language no provider speaks is a soft failure, so English keeps the premium voice", () =>
  withEnv({ ...NONE, GEMINI_API_KEY: "g" }, async () => {
    resetTtsState();
    await assert.rejects(synthesize("ਤੁਹਾਡਾ ਆਰਡਰ", undefined, signal()), (error: { status: number }) => error.status === 422);
  }));
