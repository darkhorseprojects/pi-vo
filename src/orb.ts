import { execFile } from "node:child_process";
import { readFileSync } from "node:fs";
import type { PiVoConfig, VoiceState } from "./config.js";

type Rgb = readonly [number, number, number];
type Palette = { dim: Rgb; soft: Rgb; fg: Rgb; bright: Rgb };
type Shape = { ripple: number; swirl: number; wave: number; pulse: number; breath: number; squish: number };
type TuiHost = { requestRender(): void };

const palettes: Record<VoiceState, Palette> = {
  idle: { dim: [19, 78, 74], soft: [20, 184, 166], fg: [94, 234, 212], bright: [204, 251, 241] },
  listening: { dim: [24, 75, 130], soft: [50, 140, 255], fg: [80, 220, 255], bright: [180, 245, 255] },
  working: { dim: [76, 29, 149], soft: [124, 58, 237], fg: [167, 139, 250], bright: [216, 180, 254] },
  speaking: { dim: [131, 24, 67], soft: [219, 39, 119], fg: [255, 120, 210], bright: [255, 200, 240] },
  error: { dim: [127, 29, 29], soft: [220, 38, 38], fg: [255, 107, 107], bright: [255, 190, 190] },
};

const shapes: Record<VoiceState, Shape> = {
  idle: { ripple: 0, swirl: 0, wave: 0, pulse: 0, breath: 0.08, squish: 0 },
  listening: { ripple: 0.25, swirl: 0, wave: 0, pulse: 0, breath: 0.03, squish: 0.06 },
  working: { ripple: 0, swirl: 0.22, wave: 0, pulse: 0, breath: 0.02, squish: -0.04 },
  speaking: { ripple: 0, swirl: 0.06, wave: 0.22, pulse: 0, breath: 0.04, squish: 0.04 },
  error: { ripple: 0, swirl: 0, wave: 0, pulse: 0.18, breath: 0, squish: 0 },
};

const labels: Record<VoiceState, string> = {
  idle: "ready",
  listening: "listening",
  working: "working",
  speaking: "speaking",
  error: "error",
};

const states = Object.keys(palettes) as VoiceState[];
const glyphs = [" ", ".", "·", ":", "•", "●"];
const width = 17;
const height = 7;
const colorMinWidth = 64;
const transitionFrames = 8;
const memoryColor: Rgb = [82, 82, 91];

export class MiniVoiceOrb {
  #frame = 0;
  #weights: Record<VoiceState, number> = weights("idle");
  #vram = "vram ?";
  #timer: ReturnType<typeof setInterval>;
  #memoryTimer: ReturnType<typeof setInterval>;

  constructor(
    private readonly tui: TuiHost,
    private readonly config: PiVoConfig,
    private readonly getState: () => VoiceState,
    private readonly getLiveText: () => string | undefined,
  ) {
    this.#timer = setInterval(() => {
      this.#frame += 1;
      this.tui.requestRender();
    }, 110);
    this.#memoryTimer = setInterval(() => this.refreshVram(), 2000);
    this.refreshVram();
  }

  dispose(): void {
    clearInterval(this.#timer);
    clearInterval(this.#memoryTimer);
  }

  invalidate(): void {
    this.#weights = weights(this.getState());
  }

  render(screenWidth: number): string[] {
    const state = this.getState();
    const liveText = this.getLiveText();
    const targetState = liveText ? "listening" : state;
    this.#weights = approach(this.#weights, targetState);

    const palette = mixPalette(this.#weights);
    const shape = mixShape(this.#weights);
    const useColor = screenWidth >= colorMinWidth;
    const rows = this.config.showOrb
      ? orbRows(shape, this.#frame).map((row) => center(color(row, rowColor(row, palette), useColor), screenWidth))
      : [];

    if (liveText) {
      rows.push(...wrapText(`› ${liveText}`, screenWidth, palette.fg, useColor));
    } else if (this.config.showStatus) {
      rows.push(center(color(labels[state], palette.fg, useColor), screenWidth));
    }

    if (this.config.showMemory) {
      rows.push(center(color(`[${this.#vram} ${this.ram()}]`, memoryColor, useColor), screenWidth));
    }

    return rows;
  }

  private refreshVram(): void {
    execFile("nvidia-smi", ["--query-gpu=memory.used,memory.total", "--format=csv,noheader,nounits"], { timeout: 1500 }, (error, stdout) => {
      if (!error) {
        const [used, total] = stdout.trim().split(/\s*,\s*/).map(Number);
        this.#vram = `${used}/${total}MiB`.padStart(12);
      } else {
        this.#vram = "vram ?".padStart(12);
      }
      this.tui.requestRender();
    });
  }

  private ram(): string {
    try {
      const meminfo = readFileSync("/proc/meminfo", "utf8");
      const total = Number(meminfo.match(/^MemTotal:\s+(\d+)/m)?.[1] || 0);
      const available = Number(meminfo.match(/^MemAvailable:\s+(\d+)/m)?.[1] || 0);
      if (!total || !available) return "ram ?";
      return `${((total - available) / 1024 / 1024).toFixed(1)}/${(total / 1024 / 1024).toFixed(1)}G`;
    } catch {
      return "ram ?";
    }
  }
}

function orbRows(shape: Shape, frame: number): string[] {
  const t = frame / 5;
  return Array.from({ length: height }, (_, y) => {
    const ny = (y - (height - 1) / 2) / ((height - 1) / 2);
    return Array.from({ length: width }, (_, x) => {
      const nx = (x - (width - 1) / 2) / ((width - 1) / 2);
      const ellipse = Math.sqrt((nx * nx) / (0.96 + shape.squish) + (ny * ny) / (0.82 - shape.squish * 0.5));
      if (ellipse > 1.18) return " ";
      const rim = Math.max(0, 1 - Math.abs(ellipse - 0.72) * 5.2);
      const highlight = Math.max(0, 1 - Math.hypot(nx + 0.28 * Math.cos(t), ny - 0.25 * Math.sin(t * 0.8)) * 2.2);
      const ripple = shape.ripple * Math.sin(15 * ellipse - t * 3.2);
      const swirl = shape.swirl * Math.sin(Math.atan2(ny, nx) * 3 + t * 2.5);
      const wave = shape.wave * Math.sin(x * 0.9 + t * 4.1);
      const pulse = shape.pulse * Math.sin(t * 4);
      const breath = shape.breath * Math.sin(t);
      const value = clamp(Math.max(0, 1 - ellipse) * 1.28 + rim * 0.45 + highlight * 0.35 + ripple + swirl + wave + pulse + breath);
      return glyphs[Math.round(value * (glyphs.length - 1))] ?? " ";
    }).join("");
  });
}

function rowColor(row: string, palette: Palette): Rgb {
  const density = [...row].filter((char) => char !== " ").length / width;
  if (density > 0.62) return palette.bright;
  if (density > 0.38) return palette.fg;
  if (density > 0.18) return palette.soft;
  return palette.dim;
}

function wrapText(text: string, screenWidth: number, rgb: Rgb, useColor: boolean): string[] {
  const rows: string[] = [];
  let line = "";
  for (const word of stripAnsi(text).split(" ")) {
    const next = line ? `${line} ${word}` : word;
    if (next.length > screenWidth && line) {
      rows.push(center(color(line, rgb, useColor), screenWidth));
      line = word;
    } else {
      line = next;
    }
  }
  if (line) rows.push(center(color(line, rgb, useColor), screenWidth));
  return rows;
}

function weights(state: VoiceState): Record<VoiceState, number> {
  return Object.fromEntries(states.map((candidate) => [candidate, candidate === state ? 1 : 0])) as Record<VoiceState, number>;
}

function approach(current: Record<VoiceState, number>, target: VoiceState): Record<VoiceState, number> {
  const next = { ...current };
  const step = 1 / transitionFrames;
  for (const state of states) next[state] = Math.max(0, next[state] - step);
  next[target] = Math.min(1, current[target] + step);
  const total = states.reduce((sum, state) => sum + next[state], 0) || 1;
  for (const state of states) next[state] /= total;
  return next;
}

function mixPalette(w: Record<VoiceState, number>): Palette {
  return { dim: mixRgb(w, "dim"), soft: mixRgb(w, "soft"), fg: mixRgb(w, "fg"), bright: mixRgb(w, "bright") };
}

function mixShape(w: Record<VoiceState, number>): Shape {
  return {
    ripple: mixNum(w, "ripple"),
    swirl: mixNum(w, "swirl"),
    wave: mixNum(w, "wave"),
    pulse: mixNum(w, "pulse"),
    breath: mixNum(w, "breath"),
    squish: mixNum(w, "squish"),
  };
}

function mixRgb(w: Record<VoiceState, number>, key: keyof Palette): Rgb {
  return [0, 1, 2].map((i) => Math.round(states.reduce((sum, state) => sum + palettes[state][key][i] * w[state], 0))) as unknown as Rgb;
}

function mixNum(w: Record<VoiceState, number>, key: keyof Shape): number {
  return states.reduce((sum, state) => sum + shapes[state][key] * w[state], 0);
}

function color(text: string, rgb: Rgb, useColor: boolean): string {
  return useColor ? `\x1b[38;2;${rgb[0]};${rgb[1]};${rgb[2]}m${text}\x1b[0m` : text;
}

function stripAnsi(text: string): string {
  return text.replace(/\x1b\[[0-9;]*m/g, "");
}

function center(text: string, screenWidth: number): string {
  const plain = stripAnsi(text);
  if (plain.length >= screenWidth) return plain.slice(0, screenWidth);
  return `${" ".repeat(Math.floor((screenWidth - plain.length) / 2))}${text}`;
}

function clamp(value: number): number {
  return Math.max(0, Math.min(1, value));
}
