import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { homedir } from "node:os";

export type VoiceState = "idle" | "listening" | "working" | "speaking" | "error";

export interface PiVoConfig {
  showOrb: boolean;
  showStatus: boolean;
  showMemory: boolean;
  audioDir: string;
  recordSampleRate: number;
  audioSampleRate: number;
  audioChannels: number;
  micDevice: string;
  outputDevice: string;
  recordStreamCommand: string;
  playStreamCommand: string;
  voiceVolume: number;
  voiceSpeed: number;
  autoSend: boolean;
  autoSendDelayMs: number;
  voiceSummaryMaxChars: number;
  voicePython: string;
  asrWorker: string;
  asrModel: string;
  asrDeviceMap: string;
  asrDtype: "float32" | "float16" | "bfloat16";
  asrLanguage: string | null;
  asrAttnImplementation: string;
  asrMaxNewTokens: number;
  asrMaxBatchSize: number;
  ttsWorker: string;
  ttsModel: string;
  ttsDeviceMap: string;
  ttsDtype: "float32" | "float16" | "bfloat16";
  ttsLoadIn4bit: boolean;
  ttsQuantType: "nf4" | "fp4";
  ttsComputeDtype: "float32" | "float16" | "bfloat16";
  ttsCpuOffload: boolean;
  ttsOffloadFolder: string;
  ttsReferenceAudio: string;
  ttsVoiceDesign: string;
  ttsNumSteps: number;
}

export type UserConfig = Partial<Omit<PiVoConfig, "asrWorker" | "ttsWorker">>;

const configPath = join(homedir(), ".pi", "pi-vo.json");
const here = dirname(fileURLToPath(import.meta.url));
const packageRoot = existsSync(resolve(here, "..", "workers"))
  ? resolve(here, "..")
  : existsSync(resolve(here, "..", "..", "workers"))
    ? resolve(here, "..", "..")
    : resolve(here, "..");

const defaults: PiVoConfig = {
  showOrb: true,
  showStatus: true,
  showMemory: true,
  audioDir: join(homedir(), ".pi", "pi-vo-audio"),
  recordSampleRate: 16000,
  audioSampleRate: 24000,
  audioChannels: 1,
  micDevice: "@DEFAULT_SOURCE@",
  outputDevice: "@DEFAULT_SINK@",
  recordStreamCommand:
    "pw-record --raw --rate {sampleRate} --channels 1 --format s16 --target {device} -",
  playStreamCommand:
    "pw-cat --playback --raw --rate {sampleRate} --channels {channels} --format s16 --target {device} --volume {volume} -",
  voiceVolume: 0.85,
  voiceSpeed: 1.15,
  autoSend: false,
  autoSendDelayMs: 650,
  voiceSummaryMaxChars: 320,
  voicePython: resolve(packageRoot, ".venv-voice", "bin", "python"),
  asrWorker: resolve(packageRoot, "workers", "cohere_asr_worker.py"),
  asrModel: "cstr/cohere-transcribe-onnx-int4",
  asrDeviceMap: "",
  asrDtype: "float32",
  asrLanguage: null,
  asrAttnImplementation: "",
  asrMaxNewTokens: 512,
  asrMaxBatchSize: 1,
  ttsWorker: resolve(packageRoot, "workers", "omnivoice_tts_worker.py"),
  ttsModel: "k2-fsa/OmniVoice",
  ttsDeviceMap: "cuda:0",
  ttsDtype: "bfloat16",
  ttsLoadIn4bit: true,
  ttsQuantType: "nf4",
  ttsComputeDtype: "bfloat16",
  ttsCpuOffload: true,
  ttsOffloadFolder: join(homedir(), ".pi", "pi-vo-offload"),
  ttsReferenceAudio: "",
  ttsVoiceDesign: "",
  ttsNumSteps: 16,
};

const envMap: Record<string, keyof UserConfig> = {
  PI_VO_SHOW_ORB: "showOrb",
  PI_VO_SHOW_STATUS: "showStatus",
  PI_VO_SHOW_MEMORY: "showMemory",
  PI_VO_AUDIO_DIR: "audioDir",
  PI_VO_RECORD_SAMPLE_RATE: "recordSampleRate",
  PI_VO_AUDIO_SAMPLE_RATE: "audioSampleRate",
  PI_VO_AUDIO_CHANNELS: "audioChannels",
  PI_VO_MIC_DEVICE: "micDevice",
  PI_VO_OUTPUT_DEVICE: "outputDevice",
  PI_VO_RECORD_STREAM_COMMAND: "recordStreamCommand",
  PI_VO_PLAY_STREAM_COMMAND: "playStreamCommand",
  PI_VO_VOICE_VOLUME: "voiceVolume",
  PI_VO_VOICE_SPEED: "voiceSpeed",
  PI_VO_AUTO_SEND: "autoSend",
  PI_VO_AUTO_SEND_DELAY_MS: "autoSendDelayMs",
  PI_VO_VOICE_SUMMARY_MAX_CHARS: "voiceSummaryMaxChars",
  PI_VO_VOICE_PYTHON: "voicePython",
  PI_VO_ASR_MODEL: "asrModel",
  PI_VO_ASR_DEVICE_MAP: "asrDeviceMap",
  PI_VO_ASR_DTYPE: "asrDtype",
  PI_VO_ASR_LANGUAGE: "asrLanguage",
  PI_VO_ASR_ATTN_IMPLEMENTATION: "asrAttnImplementation",
  PI_VO_ASR_MAX_NEW_TOKENS: "asrMaxNewTokens",
  PI_VO_ASR_MAX_BATCH_SIZE: "asrMaxBatchSize",
  PI_VO_TTS_MODEL: "ttsModel",
  PI_VO_OMNIVOICE_MODEL: "ttsModel",
  PI_VO_TTS_DEVICE_MAP: "ttsDeviceMap",
  PI_VO_TTS_DTYPE: "ttsDtype",
  PI_VO_TTS_LOAD_IN_4BIT: "ttsLoadIn4bit",
  PI_VO_TTS_QUANT_TYPE: "ttsQuantType",
  PI_VO_TTS_COMPUTE_DTYPE: "ttsComputeDtype",
  PI_VO_TTS_CPU_OFFLOAD: "ttsCpuOffload",
  PI_VO_TTS_OFFLOAD_FOLDER: "ttsOffloadFolder",
  PI_VO_TTS_REFERENCE_AUDIO: "ttsReferenceAudio",
  PI_VO_TTS_VOICE_DESIGN: "ttsVoiceDesign",
  PI_VO_TTS_NUM_STEPS: "ttsNumSteps",
};

const booleanKeys = new Set<keyof UserConfig>([
  "showOrb",
  "showStatus",
  "showMemory",
  "autoSend",
  "ttsLoadIn4bit",
  "ttsCpuOffload",
]);

const numberKeys = new Set<keyof UserConfig>([
  "recordSampleRate",
  "audioSampleRate",
  "audioChannels",
  "voiceVolume",
  "voiceSpeed",
  "autoSendDelayMs",
  "voiceSummaryMaxChars",
  "asrMaxNewTokens",
  "asrMaxBatchSize",
  "ttsNumSteps",
]);

export function defaultConfig(): PiVoConfig {
  return { ...defaults };
}

export function loadConfig(overrides: UserConfig = {}): PiVoConfig {
  const fileConfig = readConfig();
  const envConfig = readEnvConfig();
  const merged: PiVoConfig = {
    ...defaults,
    ...fileConfig,
    ...overrides,
    ...envConfig,
    asrWorker: defaults.asrWorker,
    ttsWorker: defaults.ttsWorker,
  };

  const resolved: PiVoConfig = {
    ...merged,
    audioDir: expandHome(merged.audioDir),
    voicePython: expandHome(merged.voicePython),
    ttsOffloadFolder: merged.ttsOffloadFolder ? expandHome(merged.ttsOffloadFolder) : "",
    ttsReferenceAudio: merged.ttsReferenceAudio ? expandHome(merged.ttsReferenceAudio) : "",
  };

  validateConfig(resolved);
  return resolved;
}

export function saveConfig(config: PiVoConfig | UserConfig): void {
  mkdirSync(dirname(configPath), { recursive: true });
  const current = readConfig();
  const serializable = stripRuntimeKeys({ ...current, ...config });
  writeFileSync(configPath, `${JSON.stringify(serializable, null, 2)}\n`, "utf8");
}

export function configFilePath(): string {
  return configPath;
}

function readConfig(): UserConfig {
  if (!existsSync(configPath)) return {};
  try {
    const parsed = JSON.parse(readFileSync(configPath, "utf8")) as UserConfig;
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

function readEnvConfig(): UserConfig {
  const out: UserConfig = {};
  for (const [envName, key] of Object.entries(envMap)) {
    const value = process.env[envName];
    if (value === undefined) continue;
    (out as Record<string, unknown>)[key] = parseEnvValue(key, value);
  }
  return out;
}

function parseEnvValue(key: keyof UserConfig, raw: string): unknown {
  const value = raw.trim();
  if (key === "asrLanguage") {
    return value === "" || value.toLowerCase() === "auto" || value.toLowerCase() === "null" ? null : value;
  }
  if (booleanKeys.has(key)) return /^(1|true|yes|on)$/i.test(value);
  if (numberKeys.has(key)) return Number(value);
  return value;
}

function stripRuntimeKeys(config: UserConfig): UserConfig {
  const copy = { ...config } as Record<string, unknown>;
  delete copy.asrWorker;
  delete copy.ttsWorker;
  return copy as UserConfig;
}

function expandHome(path: string): string {
  if (path === "~") return homedir();
  if (path.startsWith("~/")) return join(homedir(), path.slice(2));
  return path;
}

function validateConfig(config: PiVoConfig): void {
  const dtype = new Set(["float32", "float16", "bfloat16"]);
  if (config.recordSampleRate !== 16000) throw new Error("recordSampleRate must be 16000");
  if (!Number.isFinite(config.audioSampleRate) || config.audioSampleRate <= 0) throw new Error("audioSampleRate must be positive");
  if (config.audioChannels !== 1) throw new Error("audioChannels must be 1");
  if (!Number.isFinite(config.voiceVolume) || config.voiceVolume < 0 || config.voiceVolume > 1) throw new Error("voiceVolume must be 0..1");
  if (!Number.isFinite(config.voiceSpeed) || config.voiceSpeed <= 0) throw new Error("voiceSpeed must be positive");
  if (!Number.isFinite(config.autoSendDelayMs) || config.autoSendDelayMs < 0) throw new Error("autoSendDelayMs must be non-negative");
  if (!Number.isInteger(config.ttsNumSteps) || config.ttsNumSteps <= 0) throw new Error("ttsNumSteps must be a positive integer");
  if (!dtype.has(config.asrDtype)) throw new Error("asrDtype must be float32, float16, or bfloat16");
  if (!dtype.has(config.ttsDtype)) throw new Error("ttsDtype must be float32, float16, or bfloat16");
  if (!dtype.has(config.ttsComputeDtype)) throw new Error("ttsComputeDtype must be float32, float16, or bfloat16");
  if (config.ttsQuantType !== "nf4" && config.ttsQuantType !== "fp4") throw new Error("ttsQuantType must be nf4 or fp4");
  if (!config.recordStreamCommand.includes("{sampleRate}")) throw new Error("recordStreamCommand must include {sampleRate}");
  for (const token of ["{sampleRate}", "{channels}", "{device}", "{volume}"]) {
    if (!config.playStreamCommand.includes(token)) throw new Error(`playStreamCommand must include ${token}`);
  }
}