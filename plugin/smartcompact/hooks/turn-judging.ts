import type { Engine } from './engine.ts';
import { askClaudeJudge } from './claude-judge.ts';
import type { JudgeAnswer } from './claude-judge.ts';
import { JUDGE_INSTRUCTIONS } from './compact-instructions.ts';
import type { ContextFloor } from './context-floor.ts';
import { contextTokens } from './context-tokens.ts';
import { messageOf } from './error-message.ts';
import { logEvent } from './event-log.ts';
import { saveFloorState } from './floor-store.ts';
import { buildJudgeInput } from './judge-input.ts';
import type { PendingCompaction } from './pending-compaction.ts';
import type { Settings } from './plugin-settings.ts';
import { runningSubagentIds } from './running-subagents.ts';
import { showJudgeCountdown, showTimedStatus } from './status-line.ts';
import type { TurnCounter } from './turn-counter.ts';

/** What the judging of one finished turn starts from. */
export type FinishedTurn = {
  answer: string;
  /** The turn count when the turn ended. A higher count later means a new turn began. */
  turnsAtEnd: number;
};

/**
 * After each finished main turn: checks the token floor and running subagents, asks the judge,
 * and hands a yes that survives the race guard to the pending compaction.
 */
export class TurnJudging {
  #settings: Settings;
  #turns: TurnCounter;
  #floor: ContextFloor;
  #compaction: PendingCompaction;

  constructor(settings: Settings, turns: TurnCounter, floor: ContextFloor, compaction: PendingCompaction) {
    this.#settings = settings;
    this.#turns = turns;
    this.#floor = floor;
    this.#compaction = compaction;
  }

  /** Runs in the background after the turn. It never throws: a failure is logged as `judge-error`. */
  async judgeTurn(engine: Engine, turn: FinishedTurn): Promise<void> {
    try {
      await this.#judgeWhenWorthIt(engine, turn);
    } catch (error) {
      logEvent(engine, 'judge-error', { message: messageOf(error) });
      await showTimedStatus(engine, 'error');
    }
  }

  async #judgeWhenWorthIt(engine: Engine, turn: FinishedTurn): Promise<void> {
    const tokens = await contextTokens(engine);

    // A /clear or exit right after the turn can land before the count. The floor keeps waiting.
    if (tokens === undefined) {
      logEvent(engine, 'usage-missing', { hook: 'turn.complete' });

      return;
    }

    // Without the skip after a compaction a floor of 0 loops: compact, continue prompt, judged done, compact again.
    const firstTurnReason = this.#floor.takeFirstTurn(tokens);

    if (firstTurnReason !== undefined) {
      await saveFloorState(engine, this.#floor);
      logEvent(engine, 'judge-skipped', { reason: firstTurnReason, tokens });
      // The baseline was just set, so the whole floor is left.
      showJudgeCountdown(engine, this.#settings.minTokens);

      return;
    }

    if (await this.#isBelowFloor(engine, tokens)) {
      return;
    }

    if (await this.#hasRunningSubagents(engine)) {
      return;
    }

    engine.status('judging...');
    await this.#judge(engine, turn, tokens);
  }

  async #isBelowFloor(engine: Engine, tokens: number): Promise<boolean> {
    const added = this.#floor.addedTokens(tokens);

    if (added >= this.#settings.minTokens) {
      return false;
    }

    logEvent(engine, 'judge-skipped', { reason: 'below floor', tokens, added, baseline: this.#floor.baseline() });
    showJudgeCountdown(engine, this.#settings.minTokens - added);

    return true;
  }

  async #hasRunningSubagents(engine: Engine): Promise<boolean> {
    const agents = await runningSubagentIds(engine);

    if (agents.length === 0) {
      return false;
    }

    logEvent(engine, 'judge-skipped', { reason: 'subagents running', agents });
    engine.status('waiting for subagents');

    return true;
  }

  async #judge(engine: Engine, turn: FinishedTurn, tokens: number): Promise<void> {
    const startedAt = await engine.now();
    const input = buildJudgeInput(await engine.messages(), turn.answer);
    const answer = await askClaudeJudge(engine, this.#settings, input);
    const verdictDetails = verdictDetailsOf(tokens, answer, await sinceMs(engine, startedAt));

    if (!answer.verdict.compact) {
      logEvent(engine, 'judge-no', verdictDetails);
      await showTimedStatus(engine, 'keep going');

      return;
    }

    if (await this.#isCancelled(engine, turn, tokens)) {
      return;
    }

    logEvent(engine, 'judge-yes', verdictDetails);
    await showTimedStatus(engine, 'will compact');
    await this.#compaction.holdAndTry(engine, {
      reason: answer.verdict.reason,
      tokens,
      turnsAtEnd: turn.turnsAtEnd,
      instructions: JUDGE_INSTRUCTIONS,
      next: '',
      continueWhenSkipped: false,
      errorEvent: 'judge-error',
    });
  }

  /** The race guard: a turn that started or a subagent that runs since the turn ended cancels the yes. */
  async #isCancelled(engine: Engine, turn: FinishedTurn, tokens: number): Promise<boolean> {
    if (this.#turns.hasChangedSince(turn.turnsAtEnd)) {
      logEvent(engine, 'judge-cancelled', { tokens, reason: 'new turn started' });
      await showTimedStatus(engine, 'yes cancelled');

      return true;
    }

    const agents = await runningSubagentIds(engine);

    if (agents.length > 0) {
      logEvent(engine, 'judge-cancelled', { tokens, reason: 'subagents running', agents });
      await showTimedStatus(engine, 'yes cancelled');

      return true;
    }

    return false;
  }
}

function verdictDetailsOf(tokens: number, answer: JudgeAnswer, latencyMs: number): Record<string, unknown> {
  return {
    tokens,
    reason: answer.verdict.reason,
    model: answer.model,
    latencyMs,
  };
}

async function sinceMs(engine: Engine, startedAt: number): Promise<number> {
  return (await engine.now()) - startedAt;
}
