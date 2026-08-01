import { createClient, AgentEvents } from "@deepgram/sdk";
import { ClinicalApi, InsuranceApi } from "../contract";
import { bus } from "../bus";
import { SYSTEM_PROMPT, TOOLS, detectEscalation } from "./index";
import { dispatch } from "./dispatch";
import { WebSocket } from "ws";

export interface DeepgramSession {
  sendAudio: (chunk: Buffer) => void;
  close: () => void;
}

export function createDeepgramSession(
  browserSocket: WebSocket,
  clinical: ClinicalApi,
  insurance: InsuranceApi,
  patientId: string
): DeepgramSession {
  const apiKey = process.env.DEEPGRAM_API_KEY;
  if (!apiKey) throw new Error("DEEPGRAM_API_KEY is not set");

  const client = createClient(apiKey);

  console.log("[deepgram] creating agent connection");
  // agent() instantiates AgentLiveClient and opens the WebSocket immediately.
  const agent = client.agent();

  agent.on(AgentEvents.Open, () => {
    console.log("[deepgram] connection open — sending configure");
    agent.configure({
      audio: {
        input: { encoding: "linear16", sample_rate: 16000 },
        output: { encoding: "linear16", sample_rate: 16000, container: "none" },
      },
      agent: {
        listen: {
          provider: { type: "deepgram", model: "nova-2" },
        },
        speak: {
          provider: { type: "deepgram", model: "aura-asteria-en" },
        },
        think: {
          provider: { type: "open_ai", model: "gpt-4o-mini" },
          prompt: SYSTEM_PROMPT,
          functions: TOOLS,
        },
      },
    });
  });

  agent.on(AgentEvents.Welcome, (data) => {
    console.log("[deepgram] welcome", JSON.stringify(data));
  });

  agent.on(AgentEvents.SettingsApplied, (data) => {
    console.log("[deepgram] settings applied", JSON.stringify(data));
  });

  agent.on(AgentEvents.ConversationText, (data) => {
    console.log("[deepgram] conversation_text", JSON.stringify(data));
    const role = data.role === "user" ? "patient" : "agent";
    const text: string = data.content ?? "";

    bus.publish({ type: "transcript", speaker: role, text });

    // Check every patient utterance for escalation triggers.
    if (role === "patient") {
      const trigger = detectEscalation(text);
      if (trigger) {
        console.log("[deepgram] escalation detected:", trigger);
        dispatch(
          { name: "escalate_urgent", args: { trigger_phrase: trigger } },
          clinical,
          insurance
        ).then((result) => {
          agent.injectAgentMessage(result.output);
          if (result.shouldEndCall) {
            setTimeout(() => agent.disconnect(), 3000);
          }
        });
      }
    }
  });

  // FunctionCallRequest fires with an array of functions.
  // Each entry shape: { id: string, name: string, arguments: string (JSON), client_side: boolean }
  agent.on(AgentEvents.FunctionCallRequest, async (data) => {
    console.log("[deepgram] function_call_request", JSON.stringify(data));

    const functions: { id: string; name: string; arguments: string }[] =
      data.functions ?? [];

    for (const fn of functions) {
      let args: Record<string, unknown> = {};
      try {
        args = JSON.parse(fn.arguments);
      } catch {
        console.error("[deepgram] failed to parse function arguments", fn.arguments);
      }

      // Inject patientId so every tool has it without the agent needing to track it.
      args.patient_id = patientId;

      const result = await dispatch({ name: fn.name, args }, clinical, insurance);

      // FunctionCallResponse shape from SDK: { id, name, content }
      agent.functionCallResponse({
        id: fn.id,
        name: fn.name,
        content: result.output,
      });

      if (result.shouldEndCall) {
        setTimeout(() => agent.disconnect(), 3000);
      }
    }
  });

  // Binary audio frames from Deepgram → stream back to browser.
  agent.on(AgentEvents.Audio, (audioChunk: Buffer) => {
    if (browserSocket.readyState === WebSocket.OPEN) {
      browserSocket.send(audioChunk);
    }
  });

  agent.on(AgentEvents.Error, (err) => {
    console.error("[deepgram] error", JSON.stringify(err));
    bus.publish({ type: "error", message: JSON.stringify(err) });
  });

  agent.on(AgentEvents.Close, () => {
    console.log("[deepgram] connection closed");
  });

  return {
    // send() expects ArrayBufferLike — slice the underlying ArrayBuffer from the Buffer.
    sendAudio(chunk: Buffer) {
      agent.send(chunk.buffer.slice(chunk.byteOffset, chunk.byteOffset + chunk.byteLength));
    },
    close() {
      agent.disconnect();
    },
  };
}
