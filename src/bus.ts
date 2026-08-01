import { EventEmitter } from 'node:events';

export interface BusEvent {
  at: string;
  source: 'server' | 'voice' | 'clinical' | 'insurance';
  type: string;
  data?: unknown;
}

class CountbackBus extends EventEmitter {
  publish(event: Omit<BusEvent, 'at'>): void {
    const message: BusEvent = { ...event, at: new Date().toISOString() };
    // External calls and responses must stay visible during the demo. Never put secrets here.
    console.log(JSON.stringify(message));
    this.emit('event', message);
  }
}

export const bus = new CountbackBus();
