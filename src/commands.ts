import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { PiVoRuntime } from "./runtime.js";

const sttModels = {
  "qwen3-asr-0.6b": "Qwen/Qwen3-ASR-0.6B",
  "qwen3-asr-1.7b": "Qwen/Qwen3-ASR-1.7B",
} as const;

type SttShortName = keyof typeof sttModels;

export function registerCommands(pi: ExtensionAPI, runtime: PiVoRuntime): void {
  pi.registerCommand("v", {
    description:
      "Toggle pi-vo. Syntax: /v, /v warm, /v tts, /v stt [model], /v <0-100>, /v stop, /v unload, /v i [index], /v o [index].",
    handler: async (args: string, ctx: ExtensionContext) => {
      const [cmd = "", value = ""] = args.trim().split(/\s+/);
      if (!cmd) return runtime.toggleStt(ctx);

      if (/^\d+$/.test(cmd)) {
        const ok = runtime.setVolume(Number(cmd));
        ctx.ui.notify(ok ? `Voice volume: ${cmd}%` : "Volume must be 0-100", ok ? "info" : "warning");
        return;
      }

      switch (cmd) {
        case "warm":
          return runtime.warm(ctx);
        case "tts":
          return showTts(runtime, ctx);
        case "stt":
          return handleStt(runtime, value, ctx);
        case "stop":
          return runtime.stop(ctx);
        case "unload":
          return runtime.unload(ctx);
        case "i":
          return value ? runtime.selectDevice(ctx, "mic", Number(value)) : runtime.listDevices(ctx, "mic");
        case "o":
          return value ? runtime.selectDevice(ctx, "output", Number(value)) : runtime.listDevices(ctx, "output");
        default:
          return ctx.ui.notify("Unknown /v command. Try /v, /v warm, /v tts, /v stt, /v stop, /v unload, /v i, or /v o.", "warning");
      }
    },
  });
}

function showTts(runtime: PiVoRuntime, ctx: ExtensionContext): void {
  const quant = runtime.config.ttsLoadIn4bit ? `${runtime.config.ttsQuantType.toUpperCase()} 4-bit, ${runtime.config.ttsComputeDtype}` : runtime.config.ttsDtype;
  ctx.ui.notify(
    [
      "Current TTS: OmniVoice",
      `Model: ${runtime.config.ttsModel}`,
      `Device map: ${runtime.config.ttsDeviceMap}`,
      `Precision: ${runtime.config.ttsDtype}`,
      `Quantization: ${quant}`,
      `CPU offload: ${runtime.config.ttsCpuOffload ? "on" : "off"}`,
      `Offload folder: ${runtime.config.ttsOffloadFolder || "none"}`,
    ].join("\n"),
    "info",
  );
}

async function handleStt(runtime: PiVoRuntime, value: string, ctx: ExtensionContext): Promise<void> {
  const current = shortNameFor(runtime.config.asrModel);
  if (!value || value === "list") {
    const lines = Object.keys(sttModels).map((name) => `${name === current ? "*" : " "} ${name}`).join("\n");
    ctx.ui.notify(`Current STT: ${current}\nModel: ${runtime.config.asrModel}\n\n${lines}\n\nSet with /v stt <model>`, "info");
    return;
  }

  if (!isSttShortName(value)) {
    ctx.ui.notify(`Unknown STT model. Available: ${Object.keys(sttModels).join(", ")}`, "warning");
    return;
  }

  await runtime.setAsrModel(sttModels[value], ctx);
  ctx.ui.notify(`Set STT to: ${value}. Use /v to warm.`, "info");
}

function isSttShortName(value: string): value is SttShortName {
  return Object.hasOwn(sttModels, value);
}

function shortNameFor(model: string): string {
  for (const [name, id] of Object.entries(sttModels)) if (id === model) return name;
  return model;
}
