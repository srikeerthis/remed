import { EventEmitter } from "events";
import { WebSocket } from "ws";

export type BusEvent =
  | { type: "call_started" }
  | { type: "call_ended" }
  | { type: "tool_call"; tool: string; args: unknown }
  | { type: "tool_result"; tool: string; result: unknown }
  | { type: "transcript"; speaker: "agent" | "patient"; text: string }
  | { type: "discrepancy"; medication: string; reason: string }
  | { type: "coverage_result"; medication: string; copay: string }
  | { type: "escalation"; trigger: string }
  | { type: "error"; message: string };

class Bus extends EventEmitter {
  private consoleSocket: WebSocket | null = null;

  setConsoleSocket(ws: WebSocket) {
    this.consoleSocket = ws;
  }

  emit(event: string, payload?: BusEvent): boolean {
    if (payload && this.consoleSocket?.readyState === WebSocket.OPEN) {
      this.consoleSocket.send(JSON.stringify(payload));
    }
    return super.emit(event, payload);
  }

  publish(payload: BusEvent) {
    console.log("[bus]", JSON.stringify(payload));
    this.emit(payload.type, payload);
  }
}

export const bus = new Bus();
