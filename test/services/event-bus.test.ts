import { describe, it, expect, vi } from 'vitest';
import { setupTestDb, teardownTestDb } from '../helpers';

const tmpDir = setupTestDb();

const { eventBus } = await import('../../src/services/event-bus');

import { afterAll } from 'vitest';
afterAll(() => teardownTestDb(tmpDir));

describe('event-bus', () => {
  it('emits and receives events', () => {
    const handler = vi.fn();
    eventBus.on('event:new', handler);

    const payload = { id: 1, event_type: 'test' };
    eventBus.emit('event:new', payload as any);

    expect(handler).toHaveBeenCalledOnce();
    expect(handler).toHaveBeenCalledWith(payload);

    eventBus.off('event:new', handler);
  });

  it('once fires only once', () => {
    const handler = vi.fn();
    eventBus.once('mission:update', handler);

    eventBus.emit('mission:update', {} as any);
    eventBus.emit('mission:update', {} as any);

    expect(handler).toHaveBeenCalledOnce();
  });

  it('off removes a specific listener', () => {
    const handler = vi.fn();
    eventBus.on('agent:update', handler);
    eventBus.off('agent:update', handler);

    eventBus.emit('agent:update', {} as any);
    expect(handler).not.toHaveBeenCalled();
  });

  it('removeAllListeners clears everything', () => {
    const handler = vi.fn();
    eventBus.on('event:new', handler);
    eventBus.on('agent:update', handler);

    eventBus.removeAllListeners();

    eventBus.emit('event:new', {} as any);
    eventBus.emit('agent:update', {} as any);
    expect(handler).not.toHaveBeenCalled();
  });

  it('listenerCount returns correct count', () => {
    const h1 = vi.fn();
    const h2 = vi.fn();
    eventBus.on('event:new', h1);
    eventBus.on('event:new', h2);

    expect(eventBus.listenerCount('event:new')).toBe(2);

    eventBus.off('event:new', h1);
    eventBus.off('event:new', h2);
  });
});
