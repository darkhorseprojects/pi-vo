import { Type } from "@earendil-works/pi-ai";
import { defineTool, type ExtensionContext, type AgentToolUpdateCallback } from "@earendil-works/pi-coding-agent";
import type { PiVoRuntime } from "./runtime.js";

export function createVoiceTools(runtime: PiVoRuntime): ReturnType<typeof defineTool>[] {
  return [
    defineTool({
      name: "voice_say",
      label: "Voice Say",
      description: "Queue text to speak using local OmniVoice TTS. Supports tags like [laughter], [sigh], and [question-en].",
      parameters: Type.Object({
        text: Type.String({ description: "Text to speak aloud." }),
      }),
      async execute(_id: string, params: { text: string }, _signal: AbortSignal | undefined, _onUpdate: AgentToolUpdateCallback<{ queued: boolean }> | undefined, ctx?: ExtensionContext) {
        runtime.speakInBackground(ctx ?? params.text, ctx ? params.text : undefined);
        return {
          content: [{ type: "text", text: "Text queued for speech" }],
          details: { queued: true },
        };
      },
    }),
  ];
}
