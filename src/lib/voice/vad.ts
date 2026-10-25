export type VadMode = "speaking" | "recording" | "idle";
export type VadEvent = "interrupt" | "utterance_end" | null;

/** Tunables, in ms and RMS amplitude (0..1). */
const SPEAKING = { minThreshold: 0.06, maxThreshold: 0.3, echoMargin: 2.2, calibrationMs: 450, sustainMs: 320 };
const RECORDING = { threshold: 0.023, sustainMs: 120, silenceMs: 800, maxMs: 15_000 };
const GAP_MS = 150; // short dips between syllables still count as one stretch of speech

/**
 * Microphone voice-activity detection, fed ~60 times a second.
 *  - "speaking": Aria is talking. It first learns how strongly her voice leaks from the speakers
 *    into the mic (mic level ÷ her output level), then only fires "interrupt" for sustained sound
 *    well above the echo expected *at that moment*, so loud syllables of hers don't cut her off.
 *  - "recording": server-transcription mode. Fires "utterance_end" after speech then a pause.
 */
export class VoiceActivityDetector {
  /** When a voice was last detected while recording (performance.now()). */
  get lastVoiceAt(): number {
    return this.lastVoice;
  }

  private mode: VadMode = "idle";
  private modeSince = 0;
  private speechSince = 0;
  private lastVoice = 0;
  private hasSpeech = false;
  private coupling = 0;
  private echoPeak = 0;

  reset() {
    this.mode = "idle";
    this.modeSince = 0;
    this.speechSince = 0;
    this.lastVoice = 0;
    this.hasSpeech = false;
    this.coupling = 0;
    this.echoPeak = 0;
  }

  update(mode: VadMode, rms: number, now: number, outputRms = 0): VadEvent {
    if (mode !== this.mode) {
      this.reset();
      this.mode = mode;
      this.modeSince = now;
    }
    if (mode === "idle") return null;

    if (mode === "speaking") {
      if (now - this.modeSince < SPEAKING.calibrationMs) {
        this.echoPeak = Math.max(this.echoPeak, rms);
        if (outputRms > 0.01) this.coupling = Math.max(this.coupling, rms / outputRms);
        return null;
      }
      const expectedEcho = Math.max(this.coupling * outputRms, this.echoPeak * 0.5);
      const threshold = Math.min(SPEAKING.maxThreshold, Math.max(SPEAKING.minThreshold, expectedEcho * SPEAKING.echoMargin));
      if (rms <= threshold) return null;
      if (!this.speechSince || now - this.lastVoice > GAP_MS) this.speechSince = now;
      this.lastVoice = now;
      if (now - this.speechSince >= SPEAKING.sustainMs) {
        this.reset();
        return "interrupt";
      }
      return null;
    }

    if (rms > RECORDING.threshold) {
      if (!this.speechSince || now - this.lastVoice > GAP_MS) this.speechSince = now;
      this.lastVoice = now;
      if (now - this.speechSince >= RECORDING.sustainMs) this.hasSpeech = true;
    }
    const tooLong = this.hasSpeech && now - this.modeSince > RECORDING.maxMs;
    if (this.hasSpeech && (now - this.lastVoice >= RECORDING.silenceMs || tooLong)) {
      this.reset();
      return "utterance_end";
    }
    return null;
  }
}

/** Root-mean-square level of an analyser's current waveform (0..1). */
export function analyserRms(analyser: AnalyserNode, buffer: Uint8Array<ArrayBuffer>): number {
  analyser.getByteTimeDomainData(buffer);
  let sum = 0;
  for (const value of buffer) {
    const centered = (value - 128) / 128;
    sum += centered * centered;
  }
  return Math.sqrt(sum / buffer.length);
}
