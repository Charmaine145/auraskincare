/** Wraps signed 16-bit little-endian mono PCM (Gemini's TTS output) in a WAV header. */
export function pcmToWav(pcm: Buffer, sampleRate = 24000): Buffer {
  if (!pcm.length || pcm.length % 2) throw new Error("Invalid PCM audio");
  if (!Number.isInteger(sampleRate) || sampleRate < 8000 || sampleRate > 96000) throw new Error("Invalid sample rate");
  const header = Buffer.alloc(44);
  header.write("RIFF", 0);
  header.writeUInt32LE(36 + pcm.length, 4);
  header.write("WAVE", 8);
  header.write("fmt ", 12);
  header.writeUInt32LE(16, 16); // fmt chunk size
  header.writeUInt16LE(1, 20); // PCM
  header.writeUInt16LE(1, 22); // mono
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(sampleRate * 2, 28); // byte rate
  header.writeUInt16LE(2, 32); // block align
  header.writeUInt16LE(16, 34); // bits per sample
  header.write("data", 36);
  header.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([header, pcm]);
}

/** Trims leading/trailing silence from 16-bit PCM, keeping a little padding so speech isn't clipped. */
export function trimSilence(pcm: Buffer, sampleRate = 24000, threshold = 400, padMs = 80): Buffer {
  const samples = Math.floor(pcm.length / 2);
  let first = 0;
  let last = samples - 1;
  while (first < samples && Math.abs(pcm.readInt16LE(first * 2)) < threshold) first++;
  while (last > first && Math.abs(pcm.readInt16LE(last * 2)) < threshold) last--;
  if (first >= last) return pcm;
  const pad = Math.round((sampleRate * padMs) / 1000);
  return pcm.subarray(Math.max(0, first - pad) * 2, Math.min(samples, last + pad + 1) * 2);
}
