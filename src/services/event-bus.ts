import { EventEmitter } from "events";
import type { Agent, Event, Mission, Instruction } from "../db";

// ---------------------------------------------------------------------------
// Event type map
// ---------------------------------------------------------------------------

export interface SecurityEvent {
  readonly layer: number;
  readonly layerName: string;
  readonly severity: 'info' | 'warn' | 'critical';
  readonly message: string;
  readonly detail: string | null;
  readonly timestamp: string;
}

interface EventBusEvents {
  "agent:update": Agent;
  "event:new": Event;
  "mission:update": Mission;
  "instruction:new": Instruction;
  "security:event": SecurityEvent;
}

type EventName = keyof EventBusEvents;

// ---------------------------------------------------------------------------
// Typed EventEmitter wrapper
// ---------------------------------------------------------------------------

class EventBus {
  private readonly emitter = new EventEmitter();

  constructor() {
    // Allow many listeners (dashboard clients, trackers, etc.)
    this.emitter.setMaxListeners(100);
  }

  emit<K extends EventName>(event: K, payload: EventBusEvents[K]): void {
    this.emitter.emit(event, payload);
  }

  on<K extends EventName>(
    event: K,
    listener: (payload: EventBusEvents[K]) => void,
  ): void {
    this.emitter.on(event, listener);
  }

  once<K extends EventName>(
    event: K,
    listener: (payload: EventBusEvents[K]) => void,
  ): void {
    this.emitter.once(event, listener);
  }

  off<K extends EventName>(
    event: K,
    listener: (payload: EventBusEvents[K]) => void,
  ): void {
    this.emitter.off(event, listener);
  }

  removeAllListeners(event?: EventName): void {
    if (event) {
      this.emitter.removeAllListeners(event);
    } else {
      this.emitter.removeAllListeners();
    }
  }

  listenerCount(event: EventName): number {
    return this.emitter.listenerCount(event);
  }
}

// ---------------------------------------------------------------------------
// Singleton
// ---------------------------------------------------------------------------

export const eventBus = new EventBus();
