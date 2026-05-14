import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { ensureAudioDir, AudioOutput } from "./audio-output.js";
import { type PiVoConfig, type UserConfig, type VoiceState, loadConfig, saveConfig } from "./config.js";
import { MiniVoiceOrb } from "./orb.js";
import { AudioRecorder } from "./recorder.js";
import { JsonWorker } from "./worker.js";

const transcribeIntervalMs = 2400;
const minTranscribeMs = 900;
const bytesPerSample = 2;
const silenceRms = 180;
const maxBufferSeconds = 8;

class SpeechCancelled extends Error {
  constructor() {
    super("Speech cancelled");
  }
}

export class PiVoRuntime {
  readonly config: PiVoConfig;
  #state: VoiceState = "idle";
  #error = "";
  #panelVisible = false;
  #transcriptPreview = "";
  #previewTimer?: ReturnType<typeof setTimeout>;
  #recorder?: AudioRecorder;
  #transcriptTimer?: ReturnType<typeof setTimeout>;
  #transcriptQueue: Promise<void> = Promise.resolve();
  #ctx?: ExtensionContext;
  #speechGeneration = 0;
  #activeSpeechJobs = 0;
  #speechQueue: Promise<unknown> = Promise.resolve();
  #toggling?: Promise<void>;
  #cancelStart = false;
  #warmup?: Promise<void>;
  #asr: JsonWorker;
  #tts: JsonWorker;
  #output: AudioOutput;

  constructor(private readonly onAutoSend: (text: string) => void, overrides: UserConfig = {}) {
    this.config = loadConfig(overrides);
    this.#asr = new JsonWorker(this.config.voicePython, this.config.asrWorker);
    this.#tts = new JsonWorker(this.config.voicePython, this.config.ttsWorker);
    this.#output = new AudioOutput({
      command: this.config.playStreamCommand,
      sampleRate: this.config.audioSampleRate,
      channels: this.config.audioChannels,
      device: this.config.outputDevice,
      volume: this.config.voiceVolume,
    });
    void this.onAutoSend;
  }

  getState(): VoiceState {
    return this.#state;
  }

  getLastError(): string {
    return this.#error;
  }

  get isSpeakingOrPreparingSpeech(): boolean {
    return this.#activeSpeechJobs > 0;
  }

  setState(_ctx: ExtensionContext, state: VoiceState, error = ""): void {
    this.#setState(state, error);
  }

  toggleStt(ctx: ExtensionContext): Promise<void> {
    if (this.#toggling) {
      if (!this.#recorder) this.#cancelStart = true;
      return this.#toggling;
    }
    this.#toggling = this.#toggleSttOnce(ctx).finally(() => {
      this.#toggling = undefined;
    });
    return this.#toggling;
  }

  async warm(ctx?: ExtensionContext): Promise<void> {
    if (ctx) {
      this.#ctx = ctx;
      if (!this.#panelVisible) this.#showPanel(ctx);
    }
    this.#setState("working");
    await this.#warmModels();
    this.#setState(this.#recorder ? "listening" : "idle");
    ctx?.ui.notify("pi-vo voice models are warm.", "info");
  }

  speak(ctx: ExtensionContext | undefined, text: string): Promise<string> {
    const generation = this.#speechGeneration;
    this.#activeSpeechJobs += 1;
    if (ctx) this.#ctx = ctx;
    const job = this.#speechQueue.then(() => this.#speakOnce(text, generation));
    this.#speechQueue = job.catch(() => undefined);
    return job.finally(() => {
      this.#activeSpeechJobs -= 1;
    });
  }

  speakInBackground(ctxOrText: ExtensionContext | string, maybeText?: string): void {
    const text = typeof ctxOrText === "string" ? ctxOrText : maybeText ?? "";
    const ctx = typeof ctxOrText === "string" ? this.#ctx : ctxOrText;
    if (!text.trim()) return;
    void this.speak(ctx, text).catch((error) => {
      const message = error instanceof Error ? error.message : String(error);
      if (message !== "Speech cancelled") console.error(`[pi-vo] voice_say failed: ${message}`);
    });
  }

  stopPlayback(): void {
    this.#speechGeneration += 1;
    void this.#output.stopPlayback();
  }

  forgetTranscript(): void {
    if (this.#previewTimer) clearTimeout(this.#previewTimer);
    this.#previewTimer = undefined;
    this.#transcriptPreview = "";
  }

  async stop(ctx?: ExtensionContext): Promise<void> {
    this.#speechGeneration += 1;
    this.#clearTranscriptTimer();
    this.forgetTranscript();
    await this.#output.stopPlayback();
    await this.#flushTranscript();
    await Promise.all([this.#asr.stop(), this.#tts.stop()]);
    await this.#output.stop();
    this.#warmup = undefined;
    this.#setState("idle");
    ctx?.ui.notify("Stopped pi-vo", "info");
  }

  async unload(ctx: ExtensionContext): Promise<void> {
    await this.stop();
    this.#panelVisible = false;
    ctx.ui.setWidget("pi-vo-orb", undefined);
    ctx.ui.notify("Unloaded pi-vo models. Use /v to warm again.", "info");
  }

  setVolume(percent: number): boolean {
    if (!Number.isInteger(percent) || percent < 0 || percent > 100) return false;
    this.config.voiceVolume = percent / 100;
    this.#output.setVolume(this.config.voiceVolume);
    saveConfig({ voiceVolume: this.config.voiceVolume });
    return true;
  }

  async listDevices(ctx: ExtensionContext, type: "mic" | "output"): Promise<void> {
    const devices = await this.#audioDevices(type);
    if (!devices.length) {
      ctx.ui.notify(`No ${type} devices found.`, "warning");
      return;
    }
    const current = type === "mic" ? this.config.micDevice : this.config.outputDevice;
    const lines = devices.map((device, index) => `${device.name === current ? "*" : " "} [${index}] ${device.name}`).join("\n");
    ctx.ui.notify(`${type}\n\n${lines}`, "info");
  }

  async selectDevice(ctx: ExtensionContext, type: "mic" | "output", index: number): Promise<void> {
    const devices = await this.#audioDevices(type);
    const device = devices[index];
    if (!device) {
      ctx.ui.notify(`Invalid device index: ${index}`, "error");
      return;
    }

    if (type === "mic") {
      this.config.micDevice = device.name;
      saveConfig({ micDevice: device.name });
    } else {
      this.config.outputDevice = device.name;
      this.#output.configure({ device: device.name });
      saveConfig({ outputDevice: device.name });
      await this.#output.stopPlayback();
    }

    ctx.ui.notify(`Set ${type} to: ${device.name}`, "info");
  }

  async setAsrModel(model: string, ctx: ExtensionContext): Promise<void> {
    this.config.asrModel = model;
    saveConfig({ asrModel: model });
    await this.unload(ctx);
  }

  #setState(state: VoiceState, error = ""): void {
    this.#state = state;
    this.#error = error;
  }

  async #toggleSttOnce(ctx: ExtensionContext): Promise<void> {
    try {
      this.#ctx = ctx;
      if (this.#recorder) {
        await this.#flushTranscript();
        this.#setState("idle");
        return;
      }

      this.#cancelStart = false;
      if (!this.#panelVisible) this.#showPanel(ctx);
      this.#setState("working");
      await this.#flushTranscript();
      await this.#warmModels();

      if (this.#cancelStart) {
        this.#cancelStart = false;
        this.#setState("idle");
        return;
      }

      this.#startRecorder(ctx);
      this.#setState("listening");
    } catch (error) {
      this.#fail(ctx, error);
    }
  }

  #showPanel(ctx: ExtensionContext): void {
    if (!ctx.hasUI) return;
    this.#panelVisible = true;
    ctx.ui.setWidget(
      "pi-vo-orb",
      (tui: { requestRender(): void }) => new MiniVoiceOrb(tui, this.config, () => this.#state, () => this.#transcriptPreview || undefined),
      { placement: "aboveEditor" },
    );
  }

  #startRecorder(ctx: ExtensionContext): void {
    this.stopPlayback();
    this.forgetTranscript();
    const recorder = new AudioRecorder({
      command: this.config.recordStreamCommand,
      sampleRate: this.config.recordSampleRate,
      device: this.config.micDevice,
      ringSeconds: maxBufferSeconds,
    });
    this.#recorder = recorder;
    recorder.child.on("error", (error) => this.#fail(ctx, error));
    recorder.child.on("close", (code, signal) => {
      if (this.#recorder === recorder && signal !== "SIGTERM") this.#fail(ctx, new Error(`Mic exited ${signal ?? code ?? "unknown status"}`));
    });
    this.#scheduleTranscript();
  }

  #scheduleTranscript(): void {
    this.#clearTranscriptTimer();
    this.#transcriptTimer = setTimeout(() => {
      this.#transcriptTimer = undefined;
      this.#transcribeAndContinue();
    }, transcribeIntervalMs);
  }

  #clearTranscriptTimer(): void {
    if (this.#transcriptTimer) clearTimeout(this.#transcriptTimer);
    this.#transcriptTimer = undefined;
  }

  #transcribeAndContinue(): void {
    const recorder = this.#recorder;
    if (!recorder) return;
    const audio = recorder.take();
    this.#queueTranscript(audio, false);
    this.#scheduleTranscript();
  }

  async #flushTranscript(): Promise<void> {
    const recorder = this.#recorder;
    this.#recorder = undefined;
    this.#clearTranscriptTimer();
    this.forgetTranscript();
    if (!recorder) {
      await this.#transcriptQueue.catch(() => undefined);
      return;
    }
    const final = await recorder.close();
    await this.#queueTranscript(final, true);
    this.#ctx = undefined;
  }

  #queueTranscript(audio: Buffer, final: boolean): Promise<void> {
    const ctx = this.#ctx;
    this.#transcriptQueue = this.#transcriptQueue
      .catch(() => undefined)
      .then(() => this.#transcribe(audio, final))
      .catch((error) => {
        if (ctx) this.#fail(ctx, error);
        else console.error(`[pi-vo] transcription failed: ${error instanceof Error ? error.message : String(error)}`);
      });
    return this.#transcriptQueue;
  }

  async #transcribe(audio: Buffer, final: boolean): Promise<void> {
    if (!this.#shouldTranscribe(audio, final)) return;
    await this.#warmModels();
    const result = await this.#asr.request<{ text: string }>({
      op: "transcribe",
      pcm16: audio.toString("base64"),
      ...this.#asrParams(),
    });
    if (result.text) this.#pasteToEditor(result.text);
  }

  #shouldTranscribe(audio: Buffer, final: boolean): boolean {
    const minMs = final ? 250 : minTranscribeMs;
    const minBytes = Math.floor((this.config.recordSampleRate * bytesPerSample * minMs) / 1000);
    return audio.length >= minBytes && rms(audio) >= silenceRms;
  }

  async #speakOnce(text: string, generation: number): Promise<string> {
    if (generation !== this.#speechGeneration) throw new SpeechCancelled();
    try {
      this.#setState("working");
      await this.#flushTranscript();
      await this.#warmModels();
      if (generation !== this.#speechGeneration) throw new SpeechCancelled();

      const path = join(this.config.audioDir, `speech-${Date.now()}-${randomUUID()}.wav`);
      await ensureAudioDir(path);
      const result = await this.#tts.request<{ path: string }>({
        op: "speak",
        text,
        outputPath: path,
        ...this.#ttsParams(),
      });
      if (generation !== this.#speechGeneration) throw new SpeechCancelled();

      this.#setState("speaking");
      await this.#output.play(result.path);
      if (generation !== this.#speechGeneration) throw new SpeechCancelled();
      this.#setState(this.#recorder ? "listening" : "idle");
      return result.path;
    } catch (error) {
      this.#setState("idle");
      if (generation !== this.#speechGeneration) throw new SpeechCancelled();
      throw error;
    }
  }

  #warmModels(): Promise<void> {
    if (this.#warmup) return this.#warmup;
    this.#warmup = Promise.all([
      this.#asr.request({ op: "load", ...this.#asrParams() }),
      this.#tts.request({ op: "load", ...this.#ttsParams() }),
    ]).then(() => undefined).finally(() => {
      this.#warmup = undefined;
    });
    return this.#warmup;
  }

  #asrParams(): Record<string, unknown> {
    return {
      model: this.config.asrModel,
      deviceMap: this.config.asrDeviceMap,
      dtype: this.config.asrDtype,
      language: this.config.asrLanguage,
      attnImplementation: this.config.asrAttnImplementation,
      maxNewTokens: this.config.asrMaxNewTokens,
      maxBatchSize: this.config.asrMaxBatchSize,
      sampleRate: this.config.recordSampleRate,
    };
  }

  #ttsParams(): Record<string, unknown> {
    return {
      model: this.config.ttsModel,
      deviceMap: this.config.ttsDeviceMap,
      dtype: this.config.ttsDtype,
      loadIn4bit: this.config.ttsLoadIn4bit,
      quantType: this.config.ttsQuantType,
      computeDtype: this.config.ttsComputeDtype,
      cpuOffload: this.config.ttsCpuOffload,
      offloadFolder: this.config.ttsOffloadFolder,
      promptAudio: this.config.ttsPromptAudio,
      promptText: this.config.ttsPromptText,
      voiceDesign: this.config.ttsVoiceDesign,
      numSteps: this.config.ttsNumSteps,
      speed: this.config.voiceSpeed,
      sampleRate: this.config.audioSampleRate,
    };
  }

  #pasteToEditor(text: string): void {
    const ctx = this.#ctx;
    if (!ctx?.hasUI) return;
    const segment = normalizeTranscript(text);
    if (!segment || segment === this.#transcriptPreview) return;
    ctx.ui.pasteToEditor(withEditorSpacing(ctx.ui.getEditorText(), segment));
    this.#transcriptPreview = segment;
    if (this.#previewTimer) clearTimeout(this.#previewTimer);
    this.#previewTimer = setTimeout(() => {
      this.#transcriptPreview = "";
    }, 500);
    this.#setState("listening");
  }

  #fail(ctx: ExtensionContext, error: unknown): void {
    const message = error instanceof Error ? error.message : String(error);
    this.#setState("error", message);
    ctx.ui.notify(message, "error");
  }

  async #audioDevices(type: "mic" | "output"): Promise<{ name: string }[]> {
    const command = type === "mic" ? "pactl list sources short" : "pactl list sinks short";
    const child = spawn("sh", ["-lc", command], { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    child.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString();
    });
    await new Promise<void>((resolve) => child.on("close", () => resolve()));
    return stdout
      .trim()
      .split("\n")
      .filter(Boolean)
      .map((line) => ({ name: line.split(/\s+/)[1] || "" }))
      .filter((device) => device.name);
  }
}

function rms(audio: Buffer): number {
  let sum = 0;
  let count = 0;
  for (let offset = 0; offset + 1 < audio.length; offset += 2) {
    const sample = audio.readInt16LE(offset);
    sum += sample * sample;
    count += 1;
  }
  return count ? Math.sqrt(sum / count) : 0;
}

function normalizeTranscript(text: string): string {
  return text.replace(/\s+/g, " ").replace(/\s+([,.;:!?])/g, "$1").trim();
}

function withEditorSpacing(editorText: string, insertion: string): string {
  if (!editorText || /\s$/.test(editorText)) return insertion;
  if (/^[,.;:!?]/.test(insertion)) return insertion;
  return ` ${insertion}`;
}
