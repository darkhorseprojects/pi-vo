import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createInterface } from "node:readline";

export interface WorkerRequest {
  op: string;
  [key: string]: unknown;
}

interface Pending<T = unknown> {
  resolve: (value: T) => void;
  reject: (error: Error) => void;
}

export class JsonWorker {
  #child?: ChildProcessWithoutNullStreams;
  #nextId = 1;
  #pending = new Map<number, Pending>();

  constructor(
    private readonly python: string,
    private readonly script: string,
    private readonly env: NodeJS.ProcessEnv = {},
  ) {}

  async request<T = unknown>(request: WorkerRequest): Promise<T> {
    const child = this.start();
    const id = this.#nextId++;
    const payload = JSON.stringify({ id, ...request });

    return new Promise<T>((resolve, reject) => {
      this.#pending.set(id, { resolve: resolve as Pending["resolve"], reject });
      child.stdin.write(`${payload}\n`, (error) => {
        if (!error) return;
        this.#pending.delete(id);
        reject(error instanceof Error ? error : new Error(String(error)));
      });
    });
  }

  async unload<T = unknown>(): Promise<T | undefined> {
    if (!this.#child) return undefined;
    return this.request<T>({ op: "unload" });
  }

  async stop(reason = "Worker stopped"): Promise<void> {
    const child = this.#child;
    this.#child = undefined;
    for (const pending of this.#pending.values()) pending.reject(new Error(reason));
    this.#pending.clear();
    if (!child) return;
    await terminate(child);
  }

  private start(): ChildProcessWithoutNullStreams {
    if (this.#child && !this.#child.killed) return this.#child;

    const child = spawn(this.python, [this.script], {
      env: { ...process.env, ...this.env, PYTHONUNBUFFERED: "1" },
      stdio: ["pipe", "pipe", "pipe"],
      detached: true,
    });

    this.#child = child;

    const stdout = createInterface({ input: child.stdout });
    stdout.on("line", (line) => this.handleLine(line));

    child.stderr.on("data", (chunk: Buffer) => {
      const text = chunk.toString();
      // Only forward actual errors to stderr, not download progress
      if (text.includes("Traceback") || text.includes("Error:") || text.includes("Exception:")) {
        process.stderr.write(`[pi-vo worker] ${text}`);
      }
    });

    child.on("error", (error) => this.fail(error));
    child.on("close", (code, signal) => {
      if (this.#child === child) {
        this.#child = undefined;
        this.fail(new Error(`Worker exited with ${signal ?? code ?? "unknown status"}`));
      }
    });

    return child;
  }

  private handleLine(line: string): void {
    let msg: { id?: number; ok?: boolean; result?: unknown; error?: string };
    try {
      msg = JSON.parse(line) as typeof msg;
    } catch {
      // Silently ignore non-JSON lines (these are often download progress bars)
      return;
    }

    if (typeof msg.id !== "number") return;
    const pending = this.#pending.get(msg.id);
    if (!pending) return;
    this.#pending.delete(msg.id);

    if (msg.ok) pending.resolve(msg.result);
    else pending.reject(new Error(msg.error || "Worker request failed"));
  }

  private fail(error: Error): void {
    for (const pending of this.#pending.values()) pending.reject(error);
    this.#pending.clear();
  }
}

function terminate(child: ChildProcessWithoutNullStreams): Promise<void> {
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
    }, 1800).unref();
  });
}
