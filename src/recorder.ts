import { spawn, type ChildProcessByStdio } from "node:child_process";
import { Readable } from "node:stream";

export interface RecorderConfig {
  command: string;
  sampleRate: number;
  device: string;
  ringSeconds: number;
}

export class AudioRecorder {
  readonly child: ChildProcessByStdio<null, Readable, Readable>;
  #chunks: Buffer[] = [];
  #bytes = 0;
  #closed = false;
  #maxBytes: number;

  constructor(private readonly config: RecorderConfig) {
    this.#maxBytes = config.sampleRate * 2 * config.ringSeconds;
    this.child = spawn("sh", ["-lc", renderCommand(config.command, {
      sampleRate: String(config.sampleRate),
      device: shellQuote(config.device),
    })], {
      stdio: ["ignore", "pipe", "pipe"],
      detached: true,
    });

    this.child.stdout.on("data", (chunk: Buffer) => this.push(chunk));
    this.child.stderr.on("data", (chunk: Buffer) => {
      process.stderr.write(`[pi-vo recorder] ${chunk.toString()}`);
    });
    this.child.on("close", () => {
      this.#closed = true;
    });
  }

  get closed(): boolean {
    return this.#closed;
  }

  take(): Buffer {
    const out = Buffer.concat(this.#chunks, this.#bytes);
    this.#chunks = [];
    this.#bytes = 0;
    return out;
  }

  async close(): Promise<Buffer> {
    if (!this.#closed) await terminate(this.child);
    return this.take();
  }

  private push(chunk: Buffer): void {
    this.#chunks.push(chunk);
    this.#bytes += chunk.length;
    while (this.#bytes > this.#maxBytes && this.#chunks.length > 1) {
      const removed = this.#chunks.shift();
      if (removed) this.#bytes -= removed.length;
    }
  }
}

function renderCommand(template: string, values: Record<string, string>): string {
  return template.replace(/\{([a-zA-Z]+)\}/g, (_, key: string) => values[key] ?? "");
}

function terminate(child: ChildProcessByStdio<null, Readable, Readable>): Promise<void> {
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
