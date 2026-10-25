import { test } from "node:test";
import assert from "node:assert/strict";
import { pcmToWav, trimSilence } from "../src/lib/audio";
import { isAffirmative, isGoodbye, isNegative } from "../src/lib/agent/intents";
import { pickBrowserVoice } from "../src/lib/voice/player";
import { commitDelay } from "../src/lib/voice/recognition";
import { VoiceActivityDetector } from "../src/lib/voice/vad";

test("Gemini PCM becomes a valid mono 24 kHz WAV without altering samples", () => {
  const pcm = Buffer.from([0, 0, 255, 127, 0, 128]);
  const wav = pcmToWav(pcm);
  assert.equal(wav.toString("ascii", 0, 4), "RIFF");
  assert.equal(wav.toString("ascii", 8, 12), "WAVE");
  assert.equal(wav.readUInt32LE(4), wav.length - 8);
  assert.equal(wav.readUInt32LE(24), 24000);
  assert.equal(wav.readUInt16LE(22), 1);
  assert.equal(wav.readUInt16LE(34), 16);
  assert.deepEqual(wav.subarray(44), pcm);
  assert.throws(() => pcmToWav(Buffer.alloc(3)));
  assert.throws(() => pcmToWav(pcm, 1));
});

test("clip silence is trimmed but speech is kept", () => {
  const samples = new Int16Array(24000);
  samples.fill(3000, 10000, 12000);
  const trimmed = trimSilence(Buffer.from(samples.buffer));
  assert.ok(trimmed.length / 2 < 6000, "leading and trailing silence removed");
  assert.ok(trimmed.length / 2 >= 2000, "speech kept");
});

test("browser fallback prefers a female Indian English voice", () => {
  const voices = [{ name: "Microsoft Ravi", lang: "en-IN" }, { name: "Microsoft Zira", lang: "en-US" }, { name: "Microsoft Neerja Online (Natural)", lang: "en-IN" }];
  assert.equal(pickBrowserVoice(voices)?.name, voices[2].name);
  assert.equal(pickBrowserVoice(voices.slice(0, 2))?.name, "Microsoft Zira");
  assert.equal(pickBrowserVoice([{ name: "French", lang: "fr-FR" }]), null);
});

test("end-of-speech waits longer when the caller is mid-sentence", () => {
  assert.equal(commitDelay("Where is my order ORD-101?"), 350);
  assert.equal(commitDelay("My order number is"), 1400);
  assert.equal(commitDelay("ORD one zero"), 1400);
  assert.equal(commitDelay("ORD one zero one"), 350);
});

test("barge-in scales with Aria's own loudness, ignores blips, then detects real speech", () => {
  const vad = new VoiceActivityDetector();
  // First 450 ms: learn that the mic hears Aria at a quarter of her output level.
  for (let t = 0; t < 450; t += 20) assert.equal(vad.update("speaking", 0.05, t, 0.2), null);
  // Her echo at normal volume never interrupts...
  for (let t = 460; t < 1000; t += 20) assert.equal(vad.update("speaking", 0.08, t, 0.2), null);
  // ...nor does it on a loud syllable, because the threshold rises with her output.
  for (let t = 1000; t < 1500; t += 20) assert.equal(vad.update("speaking", 0.12, t, 0.5), null);
  // A short blip from the caller doesn't either.
  assert.equal(vad.update("speaking", 0.3, 1500, 0.1), null);
  assert.equal(vad.update("speaking", 0.01, 1700, 0.1), null);
  // Sustained speech clearly above the expected echo does.
  let event = null;
  for (let t = 1800; t <= 2200 && !event; t += 20) event = vad.update("speaking", 0.25, t, 0.1);
  assert.equal(event, "interrupt");
});

test("server-transcription recording ends after speech and a pause", () => {
  const vad = new VoiceActivityDetector();
  assert.equal(vad.update("recording", 0.01, 0), null);
  assert.equal(vad.update("recording", 0.05, 100), null);
  assert.equal(vad.update("recording", 0.05, 250), null);
  assert.equal(vad.update("recording", 0.01, 600), null);
  assert.equal(vad.update("recording", 0.01, 1100), "utterance_end");
});

test("confirmation replies are recognised strictly", () => {
  for (const yes of ["Yes", "yes please", "Haan ji", "go ahead", "Sure, do it", "okay"]) assert.equal(isAffirmative(yes), true, yes);
  for (const notYes of ["Yes, but where is ORD-101?", "Right, and what about shipping?", "What?"]) assert.equal(isAffirmative(notYes), false, notYes);
  for (const no of ["No", "no, keep it", "nahi", "Don't do that"]) assert.equal(isNegative(no), true, no);
  assert.equal(isGoodbye("That's all, thank you, bye"), true);
  assert.equal(isGoodbye("Bye the way, can I cancel my order?"), false);
});
