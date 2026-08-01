import { WebSocket } from 'ws';
import { ClinicalApi, InsuranceApi } from '../contract.js';
import { createDeepgramSession, DeepgramSession } from './deepgram.js';
import { bus } from '../bus.js';

let activeSession: DeepgramSession | null = null;

export async function startVoiceSession(
  browserSocket: WebSocket,
  clinical: ClinicalApi,
  insurance: InsuranceApi,
  patientId: string,
  memberId: string,
): Promise<void> {
  if (activeSession) {
    activeSession.close();
    activeSession = null;
  }

  try {
    bus.publish({ source: 'voice', type: 'session.starting', data: { patientId } });
    activeSession = await createDeepgramSession(browserSocket, clinical, insurance, patientId, memberId);

    browserSocket.on('message', (data) => {
      if (data instanceof Buffer) {
        activeSession?.sendAudio(data);
      } else if (data instanceof ArrayBuffer) {
        activeSession?.sendAudio(Buffer.from(data));
      }
    });

    bus.publish({ source: 'voice', type: 'session.active', data: { patientId } });
  } catch (err) {
    bus.publish({ source: 'voice', type: 'session.error', data: { error: String(err) } });
    throw err;
  }
}

export function stopVoiceSession(): void {
  if (activeSession) {
    activeSession.close();
    activeSession = null;
    bus.publish({ source: 'voice', type: 'session.stopped', data: {} });
  }
}
