/** Why a first turn is not judged. The text goes into the log as the skip reason. */
export type FirstTurnReason = 'first turn of session' | 'first turn after compaction';

/** What the floor keeps between restarts. */
export type FloorState = {
  baseline: number;
  waitingFor: FirstTurnReason | null;
};

/**
 * Measures the tokens a conversation added since its first turn, or since the first turn after its last compaction.
 * A resumed session from before the floor was saved counts from 0, so it keeps what it already holds.
 */
export class ContextFloor {
  #baseline = 0;
  #waitingFor: FirstTurnReason | null = null;

  /**
   * Returns why the turn is skipped when it is the awaited first turn, and makes its size the new baseline.
   * Every other turn changes nothing and gets undefined.
   */
  takeFirstTurn(tokens: number): FirstTurnReason | undefined {
    if (this.#waitingFor === null) {
      return undefined;
    }

    const reason = this.#waitingFor;

    this.#baseline = tokens;
    this.#waitingFor = null;

    return reason;
  }

  /** A new session already holds its startup context, so the first turn's size becomes the baseline. */
  startNewSession(): void {
    this.#waitingFor = 'first turn of session';
  }

  /** After any compaction the next turn's size becomes the baseline. */
  restartAfterCompaction(): void {
    this.#waitingFor = 'first turn after compaction';
  }

  /** Takes over a state saved for the same session. */
  restore(state: FloorState): void {
    this.#baseline = state.baseline;
    this.#waitingFor = state.waitingFor;
  }

  state(): FloorState {
    return { baseline: this.#baseline, waitingFor: this.#waitingFor };
  }

  baseline(): number {
    return this.#baseline;
  }

  /** Zero while the first turn is awaited. Never below zero: after a compaction the context can drop under the baseline. */
  addedTokens(tokens: number): number {
    if (this.#waitingFor !== null) {
      return 0;
    }

    return Math.max(0, tokens - this.#baseline);
  }
}
