import { pickVoice, voicesReady } from "./browserVoices";
import { segmentText } from "./languages";
import { clipText, clipUrl, hasRecordedClip, type ClipName } from "./options";

export type VoiceEngine = "premium" | "browser";

export interface SpeakOptions {
  engine: VoiceEngine;
  voice?: string;
  /** BCP-47 code of the call language (en-IN, hi-IN…); picks the browser voices. */
  language?: string;
  /** Called when the device has no voice installed for a language Aria needs. */
  onMissingVoice?: (lang: string) => void;
  /** Playback waits for this (e.g. a filler clip) while the audio is already being fetched. */
  after?: Promise<unknown>;
  onStart?: (engine: VoiceEngine) => void;
  /** `permanent` means every premium voice is out of quota or unconfigured: stop trying this call. */
  onFallback?: (reason: string, permanent: boolean) => void;
}

export interface SpeakResult {
  completed: boolean;
  engine: VoiceEngine | null;
}

class HttpError extends Error {
  constructor(message: string, readonly status: number) {
    super(message);
  }
}

const SAMPLE_RATE = 24_000;
/** Audio buffered before playback starts, so a slow network chunk doesn't leave a gap. */
const PREBUFFER_SECONDS = 0.3;
/** Fades that stop hard starts/stops from clicking (a waveform cut mid-cycle "pops"). */
const FADE_IN = 0.012;
const FADE_OUT = 0.035;
const GATE_TIMEOUT_MS = 6000;
const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
const gate = (after?: Promise<unknown>) => (after ? Promise.race([after, sleep(GATE_TIMEOUT_MS)]) : Promise.resolve());

export { pickBrowserVoice } from "./browserVoices";

/** Converts little-endian 16-bit PCM bytes into an AudioBuffer. */
function pcmBuffer(context: AudioContext, bytes: Uint8Array): AudioBuffer {
  const samples = bytes.length >> 1;
  const buffer = context.createBuffer(1, samples, SAMPLE_RATE);
  const channel = buffer.getChannelData(0);
  const view = new DataView(bytes.buffer, bytes.byteOffset, samples * 2);
  for (let i = 0; i < samples; i++) channel[i] = view.getInt16(i * 2, true) / 32768;
  return buffer;
}

/**
 * Plays Aria's voice. One AudioContext (unlocked by the Start click) carries every sound, through
 * a gain envelope into an analyser, so the orb can visualise what Aria is actually saying.
 */
export class VoicePlayer {
  private context: AudioContext | null = null;
  private output: AnalyserNode | null = null;
  private epoch = 0;
  private voiceGain: GainNode | null = null;
  private sources = new Set<AudioBufferSourceNode>();
  private controller: AbortController | null = null;
  private settle: ((completed: boolean) => void) | null = null;
  private clips = new Map<string, Promise<AudioBuffer | null>>();
  private clipGain: GainNode | null = null;
  private clipSource: AudioBufferSourceNode | null = null;
  private clipSettle: ((completed: boolean) => void) | null = null;

  get analyser(): AnalyserNode | null {
    return this.output;
  }

  audioContext(): AudioContext {
    if (!this.context || this.context.state === "closed") {
      const context = new AudioContext({ latencyHint: "interactive" });
      const analyser = context.createAnalyser();
      analyser.fftSize = 256;
      analyser.smoothingTimeConstant = 0.75;
      analyser.connect(context.destination);
      this.context = context;
      this.output = analyser;
    }
    return this.context;
  }

  /** Call synchronously inside a click handler so browsers allow audio playback. */
  unlock() {
    const context = this.audioContext();
    if (context.state === "suspended") void context.resume();
  }

  /** Stops Aria mid-sentence (barge-in, end of call) with a short fade instead of a click. */
  stop() {
    this.stopSpeech();
    this.stopClip();
  }

  dispose() {
    this.stop();
    void this.context?.close().catch(() => {});
    this.context = null;
    this.output = null;
  }

  /** Fades a gain node out, then stops (and disconnects) the given sources. */
  private fadeOut(gain: GainNode | null, sources: AudioBufferSourceNode[]) {
    const context = this.context;
    if (!context || !gain) return;
    const now = context.currentTime;
    gain.gain.cancelScheduledValues(now);
    gain.gain.setValueAtTime(gain.gain.value, now);
    gain.gain.linearRampToValueAtTime(0, now + FADE_OUT);
    for (const source of sources) {
      try {
        source.stop(now + FADE_OUT + 0.01);
      } catch {
        // Already finished.
      }
    }
    setTimeout(() => gain.disconnect(), (FADE_OUT + 0.05) * 1000);
  }

  private newGain(fadeIn: boolean): GainNode {
    const context = this.audioContext();
    const gain = context.createGain();
    gain.connect(this.output!);
    if (fadeIn) {
      gain.gain.setValueAtTime(0, context.currentTime);
      gain.gain.linearRampToValueAtTime(1, context.currentTime + FADE_IN);
    }
    return gain;
  }

  private stopSpeech() {
    this.epoch++;
    this.controller?.abort();
    this.controller = null;
    if (typeof window !== "undefined") window.speechSynthesis?.cancel();
    this.fadeOut(this.voiceGain, [...this.sources]);
    this.voiceGain = null;
    this.sources.clear();
    const settle = this.settle;
    this.settle = null;
    settle?.(false);
  }

  private stopClip() {
    if (this.clipSource) this.fadeOut(this.clipGain, [this.clipSource]);
    this.clipSource = null;
    this.clipGain = null;
    const settle = this.clipSettle;
    this.clipSettle = null;
    settle?.(false);
  }

  /** Loads a clip once: the pre-recorded file if it exists, otherwise one /api/tts request. */
  loadClip(provider: string | null, voice: string | undefined, clip: ClipName, brand?: string): Promise<AudioBuffer | null> {
    const key = `${provider}:${voice}:${clip}:${clip === "greeting" ? brand : ""}`;
    let loaded = this.clips.get(key);
    if (!loaded) {
      loaded = (async () => {
        try {
          let response = provider && voice && hasRecordedClip(provider, clip, brand) ? await fetch(clipUrl(provider, voice, clip)) : null;
          if (!response?.ok && provider) {
            response = await fetch("/api/tts", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ text: clipText(clip, brand), voice }) });
          }
          if (!response?.ok) return null;
          return await this.audioContext().decodeAudioData(await response.arrayBuffer());
        } catch {
          return null;
        }
      })();
      this.clips.set(key, loaded);
      // Don't cache failures forever (quota may come back).
      void loaded.then(buffer => {
        if (!buffer) this.clips.delete(key);
      });
    }
    return loaded;
  }

  /** Plays a short clip. Resolves true when it finishes, false if it's unavailable or stopped. */
  async playClip(provider: string | null, voice: string | undefined, clip: ClipName, onStart?: () => void, brand?: string): Promise<boolean> {
    const buffer = await this.loadClip(provider, voice, clip, brand);
    if (!buffer) return false;
    this.stopClip();
    const context = this.audioContext();
    if (context.state === "suspended") await context.resume().catch(() => {});
    return new Promise<boolean>(resolve => {
      const gain = this.newGain(true);
      const source = context.createBufferSource();
      source.buffer = buffer;
      source.connect(gain);
      this.clipGain = gain;
      this.clipSource = source;
      this.clipSettle = resolve;
      source.onended = () => {
        if (this.clipSource !== source) return;
        this.clipSource = null;
        this.clipSettle = null;
        gain.disconnect();
        resolve(true);
      };
      source.start();
      onStart?.();
    });
  }

  async speak(text: string, options: SpeakOptions): Promise<SpeakResult> {
    this.stopSpeech();
    const epoch = this.epoch;
    const alive = () => epoch === this.epoch;

    if (options.engine === "premium") {
      try {
        return { completed: await this.playStream(text, options, epoch), engine: "premium" };
      } catch (error) {
        if (!alive()) return { completed: false, engine: null };
        const status = error instanceof HttpError ? error.status : 0;
        const permanent = status === 429 || status === 503;
        options.onFallback?.(permanent ? (error as Error).message : "The premium voice is unavailable right now, so Aria is using your browser's voice.", permanent);
      }
    }
    const completed = await this.playBrowser(text, options, epoch);
    return { completed, engine: alive() ? "browser" : null };
  }

  /**
   * Plays /api/tts-stream: 24 kHz PCM is scheduled chunk by chunk after a short buffer; MP3 (Edge's
   * voices) is collected and decoded whole, which costs little since Edge sends it all at once.
   */
  private async playStream(text: string, options: SpeakOptions, epoch: number): Promise<boolean> {
    this.controller = new AbortController();
    const response = await fetch("/api/tts-stream", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text, voice: options.voice, language: options.language }),
      signal: AbortSignal.any([this.controller.signal, AbortSignal.timeout(30_000)]),
    });
    if (!response.ok || !response.body) {
      const data = await response.json().catch(() => ({}));
      throw new HttpError(data.error || "The premium voice is unavailable.", response.status);
    }

    const context = this.audioContext();
    if (context.state === "suspended") await context.resume().catch(() => {});
    const mp3 = response.headers.get("Content-Type")?.startsWith("audio/mpeg") ?? false;
    const encoded: Uint8Array[] = [];
    const reader = response.body.getReader();
    const gain = this.newGain(false);
    this.voiceGain = gain;
    const queued: AudioBuffer[] = [];
    let queuedSeconds = 0;
    let started = false;
    let released = !options.after;
    let received = false;
    let nextTime = 0;
    let carry: number | undefined;

    const schedule = (buffer: AudioBuffer) => {
      if (epoch !== this.epoch) return;
      const now = context.currentTime;
      const late = nextTime < now + 0.01;
      let target: AudioNode = gain;
      if (!started || late) {
        // Starting (or restarting after a network gap): fade in instead of jumping to full volume.
        nextTime = now + 0.03;
        const fade = context.createGain();
        fade.gain.setValueAtTime(0, nextTime);
        fade.gain.linearRampToValueAtTime(1, nextTime + FADE_IN);
        fade.connect(gain);
        target = fade;
      }
      const source = context.createBufferSource();
      source.buffer = buffer;
      source.connect(target);
      source.start(nextTime);
      nextTime += buffer.duration;
      this.sources.add(source);
      source.onended = () => this.sources.delete(source);
      if (!started) {
        started = true;
        options.onStart?.("premium");
      }
    };
    const flush = () => {
      queued.splice(0).forEach(schedule);
      queuedSeconds = 0;
    };
    const opened = gate(options.after).then(() => {
      released = true;
      if (queuedSeconds >= PREBUFFER_SECONDS) flush();
    });

    try {
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        if (epoch !== this.epoch) return false;
        if (mp3) {
          encoded.push(value);
          continue;
        }
        let bytes = value;
        if (carry !== undefined) {
          bytes = new Uint8Array(value.length + 1);
          bytes[0] = carry;
          bytes.set(value, 1);
          carry = undefined;
        }
        if (bytes.length % 2) {
          carry = bytes[bytes.length - 1];
          bytes = bytes.subarray(0, -1);
        }
        if (!bytes.length) continue;
        const buffer = pcmBuffer(context, bytes);
        received = true;
        if (started && released) schedule(buffer);
        else {
          queued.push(buffer);
          queuedSeconds += buffer.duration;
          if (released && queuedSeconds >= PREBUFFER_SECONDS) flush();
        }
      }
    } catch (error) {
      if (epoch !== this.epoch) return false;
      if (!received) throw error; // Nothing played yet: let the caller fall back.
    } finally {
      reader.cancel().catch(() => {});
    }
    if (mp3 && encoded.length) {
      const whole = new Uint8Array(encoded.reduce((sum, chunk) => sum + chunk.length, 0));
      encoded.reduce((offset, chunk) => (whole.set(chunk, offset), offset + chunk.length), 0);
      const buffer = await context.decodeAudioData(whole.buffer);
      if (epoch !== this.epoch) return false;
      queued.push(buffer);
      queuedSeconds += buffer.duration;
      received = true;
    }
    if (!received) throw new HttpError("No audio returned", 502);
    await opened;
    if (epoch !== this.epoch) return false;
    flush(); // Short lines may never reach the prebuffer size.

    return new Promise<boolean>(resolve => {
      this.settle = resolve;
      setTimeout(() => {
        if (this.settle !== resolve) return;
        this.settle = null;
        resolve(true);
      }, Math.max(0, nextTime - context.currentTime) * 1000 + 80);
    });
  }

  /**
   * Speaks with the browser's own voices. The reply is split by script so Hindi text is read by a
   * Hindi voice, Tamil by a Tamil voice and English by an Indian English voice, one after another.
   */
  private async playBrowser(text: string, options: SpeakOptions, epoch: number): Promise<boolean> {
    const synth = typeof window !== "undefined" ? window.speechSynthesis : undefined;
    if (!synth) return false;
    await gate(options.after);
    const voices = await voicesReady();
    let started = false;
    const missing = new Set<string>();

    for (const segment of segmentText(text, options.language)) {
      if (epoch !== this.epoch) return false;
      const voice = pickVoice(voices, segment.lang);
      if (!voice && voices.length && segment.lang !== "en-IN") {
        // Reading Tamil script with an English voice is gibberish; skip it and say why once.
        if (!missing.has(segment.lang)) options.onMissingVoice?.(segment.lang);
        missing.add(segment.lang);
        continue;
      }
      const finished = await new Promise<boolean>(resolve => {
        const utterance = new SpeechSynthesisUtterance(segment.text);
        if (voice) utterance.voice = voice;
        utterance.lang = voice?.lang || segment.lang;
        utterance.rate = 1;
        utterance.pitch = 1.03;
        this.settle = resolve;
        utterance.onstart = () => {
          if (started) return;
          started = true;
          options.onStart?.("browser");
        };
        const finish = (completed: boolean) => {
          if (this.settle === resolve) this.settle = null;
          resolve(completed);
        };
        utterance.onend = () => finish(true);
        utterance.onerror = () => finish(false);
        synth.speak(utterance);
      });
      if (!finished) return false;
    }
    return true;
  }
}
