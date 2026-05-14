import { spawn, type ChildProcessByStdio } from "node:child_process";
import { Writable, Readable } from "node:stream";
import { mkdir, readFile } from "node:fs/promises";
import { dirname } from "node:path";
import { readPcmWav } from "./wav.js";

export interface AudioOutputConfig {
  command: string;
  sampleRate: number;
  channels: number;
  device: string;
  volume: number;
}

export class AudioOutput {
  #current?: ChildProcessByStdio<Writable, null, Readable>;

  constructor(private config: AudioOutputConfig) {}

  configure(config: Partial<AudioOutputConfig>): void {
    this.config = { ...this.config, ...config };
  }

  setVolume(volume: number): void {
    this.configure({ volume });
  }

  async play(wavPath: string): Promise<void> {
    const wav = readPcmWav(await readFile(wavPath));
    if (wav.sampleRate !== this.config.sampleRate) {
      throw new Error(`Expected ${this.config.sampleRate} Hz audio, got ${wav.sampleRate} Hz`);
    }

    await this.stopPlayback();
    const command = renderCommand(this.config.command, {
      sampleRate: String(this.config.sampleRate),
      channels: String(this.config.channels),
      device: shellQuote(this.config.device),
      volume: String(this.config.volume),
    });

    const child = spawn("sh", ["-lc", command], {
      stdio: ["pipe", "ignore", "pipe"],
      detached: true,
    });
    this.#current = child;

    child.stderr.on("data", (chunk: Buffer) => {
      process.stderr.write(`[pi-vo playback] ${chunk.toString()}`);
    });

    try {
      await writeAll(child, fadeIn(wav.pcm));
      child.stdin.end();
      await waitForExit(child);
    } finally {
      if (this.#current === child) this.#current = undefined;
    }
  }

  async stopPlayback(): Promise<void> {
    const child = this.#current;
    this.#current = undefined;
    if (!child) return;
    await terminate(child);
  }

  async stop(): Promise<void> {
    await this.stopPlayback();
  }
}

export async function ensureAudioDir(path: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
}

function renderCommand(template: string, values: Record<string, string>): string {
  return template.replace(/\{([a-zA-Z]+)\}/g, (_, key: string) => values[key] ?? "");
}

function fadeIn(pcm: Buffer): Buffer {
  const copy = Buffer.from(pcm);
  const samples = Math.min(Math.floor(copy.length / 2), 72);
  for (let i = 0; i < samples; i++) {
    const value = copy.readInt16LE(i * 2);
    copy.writeInt16LE(Math.round(value * (i / samples)), i * 2);
  }
  return copy;
}

async function writeAll(child: ChildProcessByStdio<Writable, null, Readable>, data: Buffer): Promise<void> {
  const chunkSize = 64 * 1024;
  for (let offset = 0; offset < data.length; offset += chunkSize) {
    const chunk = data.subarray(offset, Math.min(offset + chunkSize, data.length));
    await new Promise<void>((resolve, reject) => {
      child.stdin.write(chunk, (error) => (error ? reject(error) : resolve()));
    });
  }
}

function waitForExit(child: ChildProcessByStdio<Writable, null, Readable>): Promise<void> {
  return new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("close", (code, signal) => {
      if (code === 0) resolve();
      else reject(new Error(`Playback exited with ${signal ?? code ?? "unknown status"}`));
    });
  });
}

function terminate(child: ChildProcessByStdio<Writable, null, Readable>): Promise<void> {
  return new Promise((resolve) => {
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      resolve();
    };

    child.once("close", finish);
    try {
      if (child.pid) process.kill(-child.pid, "SIGTERM");
      else child.kill("SIGTERM");
    } catch {
      try {
        child.kill("SIGTERM");
      } catch {
        finish();
      }
    }

    setTimeout(() => {
      try {
        if (child.pid) process.kill(-child.pid, "SIGKILL");
        else child.kill("SIGKILL");
      } catch {
        finish();
      }
    }, 1000).unref();
  });
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'"'"'`)}'`;
}
