import type { ContextFloor } from './context-floor.ts';
import type { Engine } from './engine.ts';
import { loadFloorState } from './floor-store.ts';

/**
 * Sets the floor for a starting session. Saved state for this session id wins, so a resume keeps its count.
 * Without it an empty conversation is a new session and anything else counts from 0.
 */
export async function startFloor(engine: Engine, floor: ContextFloor): Promise<void> {
  const saved = await loadFloorState(engine, await engine.sessionId());

  if (saved !== undefined) {
    floor.restore(saved);

    return;
  }

  if ((await engine.messages()).length === 0) {
    floor.startNewSession();
  }
}
