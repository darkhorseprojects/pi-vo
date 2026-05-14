import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { isKeyRelease, isKeyRepeat, matchesKey } from "@earendil-works/pi-tui";
import { registerCommands } from "./commands.js";
import { PiVoRuntime } from "./runtime.js";
import { createVoiceTools } from "./tools.js";

export default function piVo(pi: ExtensionAPI): void {
  const runtime = new PiVoRuntime((text) => pi.sendUserMessage(text), (pi as { config?: Record<string, unknown> }).config ?? {});

  for (const tool of createVoiceTools(runtime)) pi.registerTool(tool);
  registerCommands(pi, runtime);

  pi.on("session_start", (_event: unknown, ctx: any) => {
    runtime.setState(ctx, "idle");
    ctx.ui.onTerminalInput((data: string) => {
      if (data === "\x1b") {
        runtime.cancelSpeech();
        runtime.setState(ctx, "idle");
        return undefined;
      }
      if (matchesKey(data, "enter") && !isKeyRelease(data) && !isKeyRepeat(data)) {
        runtime.forgetTranscript();
        return undefined;
      }
      if (matchesKey(data, "ctrl+space") && !isKeyRelease(data) && !isKeyRepeat(data)) {
        void runtime.toggleStt(ctx);
        return { consume: true };
      }
      return undefined;
    });
  });

  pi.on("session_shutdown", async () => runtime.stop());
  pi.on("agent_start", async (_event: unknown, ctx: any) => {
    if (runtime.getState() === "idle") runtime.setState(ctx, "working");
  });
  pi.on("agent_end", async (_event: unknown, ctx: any) => {
    if (runtime.getState() === "working" && !runtime.isSpeakingOrPreparingSpeech) runtime.setState(ctx, "idle");
  });
  pi.on("turn_end", async (_event: unknown, ctx: any) => {
    if (runtime.getState() === "working" && !runtime.isSpeakingOrPreparingSpeech) runtime.setState(ctx, "idle");
  });
}
