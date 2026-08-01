import { WebSocket } from "ws";
import { stubClinical, stubInsurance } from "../contract";
import { createDeepgramSession, DeepgramSession } from "./deepgram";
import { bus } from "../bus";

// Swap these out for B's and C's real implementations at integration time.
const clinical = stubClinical;
const insurance = stubInsurance;

// Patient ID matches the demo patient seeded by Person B in Medplum.
// John Alvarez — memberId MBR10001, DOB 1968-03-14.
const PATIENT_ID = "MBR10001";

let activeSession: DeepgramSession | null = null;

export async function startVoiceSession(browserSocket: WebSocket): Promise<void> {
  if (activeSession) {
    console.warn("[session] session already active, closing previous");
    activeSession.close();
    activeSession = null;
  }

  try {
    console.log("[session] starting voice session for patient", PATIENT_ID);
    activeSession = createDeepgramSession(
      browserSocket,
      clinical,
      insurance,
      PATIENT_ID
    );

    // Forward incoming browser audio chunks to Deepgram.
    browserSocket.on("message", (data) => {
      if (data instanceof Buffer) {
        activeSession?.sendAudio(data);
      } else if (data instanceof ArrayBuffer) {
        activeSession?.sendAudio(Buffer.from(data));
      }
    });

    console.log("[session] voice session active");
  } catch (err) {
    console.error("[session] failed to start voice session", err);
    bus.publish({ type: "error", message: String(err) });
  }
}

export function stopVoiceSession(): void {
  if (activeSession) {
    console.log("[session] stopping voice session");
    activeSession.close();
    activeSession = null;
  }
}
