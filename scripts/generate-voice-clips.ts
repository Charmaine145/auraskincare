/**
 * Pre-records Aria's greeting and "let me check" filler for every voice of the primary TTS
 * provider into public/audio/<provider>/. Clips play instantly and cost no quota at call time
 * (without them the app requests each clip from /api/tts once per server instance).
 *   npx tsx scripts/generate-voice-clips.ts           all voices of the primary provider
 *   npx tsx scripts/generate-voice-clips.ts Leda      one voice
 */
import { mkdir, writeFile } from "node:fs/promises";
import { pcmToWav, trimSilence } from "../src/lib/audio";
import { CLIP_NAMES, clipText, clipUrl } from "../src/lib/voice/options";
import { readAll, SAMPLE_RATE, synthesize, ttsProviders } from "../src/lib/voice/tts";

process.loadEnvFile?.(".env.local");

async function main() {
  const provider = ttsProviders()[0];
  if (!provider) throw new Error("Configure a TTS provider key in .env.local first (see .env.example).");
  if (provider.format === "mp3") throw new Error(`${provider.id} returns MP3 and is fast enough live; clips are only recorded for PCM providers (set EDGE_TTS=0).`);
  const only = process.argv.slice(2);
  await mkdir(`public/audio/${provider.id}`, { recursive: true });
  for (const voice of provider.voices()) {
    if (only.length && !only.includes(voice.id)) continue;
    for (const clip of CLIP_NAMES) {
      const result = await synthesize(clipText(clip), voice.id, AbortSignal.timeout(60_000));
      if (result.provider !== provider.id) throw new Error(`${provider.id} is unavailable (answered by ${result.provider}); try again later.`);
      const pcm = await readAll(result.stream);
      const wav = pcmToWav(trimSilence(pcm.subarray(0, pcm.length - (pcm.length % 2)), SAMPLE_RATE), SAMPLE_RATE);
      const path = `public${clipUrl(provider.id, voice.id, clip)}`;
      await writeFile(path, wav);
      console.log(`${path}  ${((wav.length - 44) / (SAMPLE_RATE * 2)).toFixed(1)} s`);
    }
  }
}

main().catch(error => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
