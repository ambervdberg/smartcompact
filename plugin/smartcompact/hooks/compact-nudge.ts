import type { ContextFloor } from './context-floor.ts';
import { contextTokens } from './context-tokens.ts';
import type { Engine } from './engine.ts';
import { messageOf } from './error-message.ts';
import { logEvent } from './event-log.ts';
import type { Settings } from './plugin-settings.ts';
import { showTimedStatus } from './status-line.ts';

// A floor of 0 for a live test would else nudge after every tool call.
const MIN_STEP_TOKENS = 10_000;

/** How every nudge row starts. The judge input skips rows that start this way. */
export const NUDGE_TEXT_START = 'smartcompact: ';

/** The row that asks the session to pick a moment to compact, with the added tokens in thousands. */
export function nudgeText(addedTokens: number): string {
  const added = `${Math.floor(addedTokens / 1000)}k`;

  return [
    `${NUDGE_TEXT_START}this conversation grew ${added} tokens since smartcompact started counting.`,
    'Plan a compaction at the next good moment.',
    'Start no new subagents and let the running ones finish.',
    'Then end your answer with <smartcompact>the prompt to start the next piece with</smartcompact>.',
    'Do this also when you would wait for the user, and put your question in the tag.',
    'Leave the tag out when the user must confirm an action that is hard to undo,',
    'such as a push, a delete or a publish.',
  ].join(' ');
}

/**
 * Asks the main session to compact once the floor is passed, and again after each further step.
 * The session picks the moment itself, so a session that always runs subagents still compacts.
 */
export class CompactNudge {
  #settings: Settings;
  #floor: ContextFloor;
  /** The added tokens at the last nudge since the count started over, undefined before the first. */
  #lastNudgeAt: number | undefined;
  /** The floor baseline at the last nudge. A different baseline means the floor restarted. */
  #baselineAtNudge: number | undefined;
  #nudges = 0;
  #isChecking = false;

  constructor(settings: Settings, floor: ContextFloor) {
    this.#settings = settings;
    this.#floor = floor;
  }

  /** Runs after a main tool result is stored. It never throws: a failure is logged as `nudge-error`. */
  async nudgeIfDue(engine: Engine): Promise<void> {
    // Parallel tool calls store several results at once. One check is enough for all of them.
    if (this.#isChecking) {
      return;
    }

    this.#isChecking = true;

    try {
      await this.#nudgeIfDue(engine);
    } catch (error) {
      logEvent(engine, 'nudge-error', { message: messageOf(error) });
    } finally {
      this.#isChecking = false;
    }
  }

  async #nudgeIfDue(engine: Engine): Promise<void> {
    const tokens = await contextTokens(engine);

    if (tokens === undefined) {
      logEvent(engine, 'usage-missing', { hook: 'session.append' });

      return;
    }

    const added = this.#floor.addedTokens(tokens);

    if (!this.#isDue(added)) {
      return;
    }

    const appended = await engine.appendNote(nudgeText(added));

    if (appended.deny !== undefined) {
      logEvent(engine, 'nudge-error', { message: appended.deny });

      return;
    }

    this.#lastNudgeAt = added;
    this.#baselineAtNudge = this.#floor.baseline();
    this.#nudges += 1;
    logEvent(engine, 'nudge-sent', { tokens, added, nudge: this.#nudges });
    await showTimedStatus(engine, 'nudged');
  }

  #isDue(added: number): boolean {
    // A compaction or /clear restarts the floor, so the nudges count from 1 again.
    if (this.#floor.state().waitingFor !== null || this.#hasBaselineMoved()) {
      this.startCountOver();
    }

    if (this.#floor.state().waitingFor !== null || added < this.#settings.minTokens) {
      return false;
    }

    return this.#lastNudgeAt === undefined || added - this.#lastNudgeAt >= this.#step();
  }

  // The floor takes a new baseline on its first turn after a compaction, a /clear or a new session.
  #hasBaselineMoved(): boolean {
    return this.#baselineAtNudge !== undefined && this.#floor.baseline() !== this.#baselineAtNudge;
  }

  #step(): number {
    return Math.max(Math.floor(this.#settings.minTokens / 2), MIN_STEP_TOKENS);
  }

  /** Forgets the last nudge, so the next one is number 1. */
  startCountOver(): void {
    this.#lastNudgeAt = undefined;
    this.#baselineAtNudge = undefined;
    this.#nudges = 0;
  }
}
