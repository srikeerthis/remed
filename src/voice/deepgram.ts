import { DeepgramClient } from '@deepgram/sdk';
import type { Deepgram } from '@deepgram/sdk';
import { ClinicalApi, InsuranceApi } from '../contract.js';
import { bus } from '../bus.js';
import { SYSTEM_PROMPT, detectEscalation } from './prompt.js';
import { TOOLS } from './tools.js';
import { dispatch } from './dispatch.js';
import { WebSocket } from 'ws';

export interface DeepgramSession {
  sendAudio: (chunk: Buffer) => void;
  close: () => void;
}

export async function createDeepgramSession(
  browserSocket: WebSocket,
  clinical: ClinicalApi,
  insurance: InsuranceApi,
  patientId: string,
  memberId: string,
): Promise<DeepgramSession> {
  const apiKey = process.env.DEEPGRAM_API_KEY;
  if (!apiKey) throw new Error('DEEPGRAM_API_KEY is not set');

  const client = new DeepgramClient({ apiKey });

  const socket = await client.agent.v1.connect({ Authorization: apiKey });
  let resolveSettingsApplied!: () => void;
  let rejectSettingsApplied!: (error: Error) => void;
  const settingsApplied = new Promise<void>((resolve, reject) => {
    resolveSettingsApplied = resolve;
    rejectSettingsApplied = reject;
  });

  socket.on('message', async (msg) => {
    if (typeof msg === 'string') return;

    if (msg.type === 'Welcome') {
      bus.publish({ source: 'voice', type: 'deepgram.welcome', data: msg });
      return;
    }

    if (msg.type === 'SettingsApplied') {
      bus.publish({ source: 'voice', type: 'deepgram.settings_applied', data: msg });
      resolveSettingsApplied();
      return;
    }

    if (msg.type === 'ConversationText') {
      const role = msg.role === 'user' ? 'patient' : 'agent';
      const text = msg.content ?? '';
      bus.publish({ source: 'voice', type: 'transcript', data: { role, text } });

      if (role === 'patient') {
        const trigger = detectEscalation(text);
        if (trigger) {
          bus.publish({ source: 'voice', type: 'escalation.detected', data: { trigger } });
          const result = await dispatch(
            { name: 'escalate_urgent', args: { trigger_phrase: trigger } },
            clinical, insurance, patientId, memberId,
          );
          socket.sendInjectAgentMessage({ type: 'InjectAgentMessage', message: result.output, behavior: 'interrupt' });
          if (result.shouldEndCall) setTimeout(() => socket.close(), 3000);
        }
      }
      return;
    }

    if (msg.type === 'FunctionCallRequest') {
      bus.publish({ source: 'voice', type: 'deepgram.function_call_request', data: { functions: msg.functions.map((f) => f.name) } });

      for (const fn of msg.functions) {
        let args: Record<string, unknown> = {};
        try {
          args = JSON.parse(fn.arguments);
        } catch {
          bus.publish({ source: 'voice', type: 'deepgram.parse_error', data: { raw: fn.arguments } });
        }

        const result = await dispatch({ name: fn.name, args }, clinical, insurance, patientId, memberId);

        socket.sendFunctionCallResponse({
          type: 'FunctionCallResponse',
          id: fn.id,
          name: fn.name,
          content: result.output,
        });

        if (result.shouldEndCall) setTimeout(() => socket.close(), 3000);
      }
      return;
    }

    if (msg.type === 'Error') {
      bus.publish({ source: 'voice', type: 'deepgram.error', data: msg });
      rejectSettingsApplied(new Error(`Deepgram rejected the session: ${JSON.stringify(msg)}`));
      return;
    }
  });

  // Binary audio from Deepgram → stream to browser.
  socket.socket.addEventListener('message', (event: MessageEvent) => {
    if (event.data instanceof ArrayBuffer && browserSocket.readyState === WebSocket.OPEN) {
      browserSocket.send(Buffer.from(event.data));
    }
  });

  socket.on('close', () => {
    bus.publish({ source: 'voice', type: 'deepgram.closed', data: {} });
    rejectSettingsApplied(new Error('Deepgram closed before applying settings'));
  });

  socket.on('error', (err) => {
    bus.publish({ source: 'voice', type: 'deepgram.error', data: { message: err.message } });
    rejectSettingsApplied(err);
  });

  socket.connect();
  await socket.waitForOpen();
  bus.publish({ source: 'voice', type: 'deepgram.open', data: {} });
  socket.sendSettings({
    type: 'Settings',
    audio: {
      input: { encoding: 'linear16', sample_rate: 16000 },
      output: { encoding: 'linear16', sample_rate: 16000, container: 'none' },
    },
    agent: {
      listen: { provider: { type: 'deepgram', model: 'nova-2' } as Deepgram.agent.AgentV1SettingsAgentContextListenProvider },
      speak: { provider: { type: 'deepgram', model: 'aura-asteria-en' } },
      think: {
        provider: { type: 'open_ai', model: 'gpt-4o-mini' } as unknown as Deepgram.ThinkSettingsV1Provider,
        prompt: SYSTEM_PROMPT,
        functions: TOOLS,
      },
    },
  });
  await Promise.race([
    settingsApplied,
    new Promise<never>((_resolve, reject) => {
      setTimeout(() => reject(new Error('Timed out waiting for Deepgram settings')), 10_000);
    }),
  ]);

  return {
    sendAudio(chunk: Buffer) {
      socket.sendMedia(chunk);
    },
    close() {
      socket.close();
    },
  };
}
