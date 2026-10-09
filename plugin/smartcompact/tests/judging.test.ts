import { describe, expect, mock, test } from 'claude-code/testing';
import { claudeVerdict, fakeSession, finishedTurn, loggedEvents, loggedLines } from './fake-engine.ts';

const START = Date.UTC(2026, 9, 4, 10, 0);
const HOME = { USERPROFILE: 'C:/home' };

describe('token floor', () => {
  test('shows the countdown from the current context as soon as the session starts', async ($, on) => {
    mock.env(on, HOME);
    const session = fakeSession(on);

    session.tokens = 25000;
    await $.session.start({ cwd: 'C:/work', surface: 'terminal', isInteractive: true });

    expect(session.statuses).toEqual(['judge in 35k']);
  });

  test('a resumed session above the floor is judged after its next turn', async ($, on) => {
    const clock = mock.clock(on, { now: START });
    mock.env(on, HOME);
    const session = fakeSession(on);

    session.tokens = 188000;
    await $.session.start({ cwd: 'C:/work', surface: 'terminal', isInteractive: true });

    expect(session.statuses).toEqual(['judge after next turn']);

    await $.turn.complete(finishedTurn());
    await clock.settle();

    expect(session.claudeModels).toEqual(['haiku']);
  });

  test('skips the judge until the context reaches the floor', async ($, on) => {
    const clock = mock.clock(on, { now: START });
    mock.env(on, HOME);
    const session = fakeSession(on);

    session.tokens = 20000;
    await $.turn.complete(finishedTurn('turn-1'));
    await clock.settle();

    expect(session.claudeModels).toEqual([]);
    expect(session.statuses.at(-1)).toBe('judge in 40k');
    expect(loggedLines(session)[0]).toMatchObject({ event: 'judge-skipped', reason: 'below floor', baseline: 0 });

    session.tokens = 50000;
    await $.turn.complete(finishedTurn('turn-2'));
    await clock.settle();

    expect(session.statuses.at(-1)).toBe('judge in 10k');

    session.tokens = 60000;
    await $.turn.complete(finishedTurn('turn-3'));
    await clock.settle();

    expect(session.claudeModels).toEqual(['haiku']);
  });

  test('follows the minTokens option', { options: { minTokens: 0 } }, async ($, on) => {
    const clock = mock.clock(on, { now: START });
    mock.env(on, HOME);
    const session = fakeSession(on);

    await $.turn.complete(finishedTurn());
    await clock.settle();

    expect(session.claudeModels).toEqual(['haiku']);
  });
});

describe('subagents', () => {
  test('skips the judge while a subagent runs', { options: { minTokens: 0 } }, async ($, on) => {
    const clock = mock.clock(on, { now: START });
    mock.env(on, HOME);
    const session = fakeSession(on);
    session.agents = [{ id: 'agent-1', description: 'review', type: 'general-purpose', status: 'running' }];

    await $.turn.complete(finishedTurn());
    await clock.settle();

    expect(session.claudeModels).toEqual([]);
    expect(session.statuses.at(-1)).toBe('waiting for subagents');
    expect(loggedLines(session)[0]).toMatchObject({ reason: 'subagents running', agents: ['agent-1'] });
  });

  test('judges when every subagent has finished', { options: { minTokens: 0 } }, async ($, on) => {
    const clock = mock.clock(on, { now: START });
    mock.env(on, HOME);
    const session = fakeSession(on);
    session.agents = [{ id: 'agent-1', description: 'review', type: 'general-purpose', status: 'completed' }];

    await $.turn.complete(finishedTurn());
    await clock.settle();

    expect(session.claudeModels).toEqual(['haiku']);
  });
});

describe('judge model', () => {
  test('asks the default Claude model', { options: { minTokens: 0 } }, async ($, on) => {
    const clock = mock.clock(on, { now: START });
    mock.env(on, HOME);
    const session = fakeSession(on);

    await $.turn.complete(finishedTurn());
    await clock.settle();

    expect(session.claudeModels).toEqual(['haiku']);
    expect(loggedLines(session)[0]).toMatchObject({ event: 'judge-yes', model: 'haiku' });
  });

  test('asks the chosen Claude model', { options: { minTokens: 0, claudeModel: 'sonnet' } }, async ($, on) => {
    const clock = mock.clock(on, { now: START });
    mock.env(on, HOME);
    const session = fakeSession(on);

    await $.turn.complete(finishedTurn());
    await clock.settle();

    expect(session.claudeModels).toEqual(['sonnet']);
    expect(loggedLines(session)[0]).toMatchObject({ event: 'judge-yes', model: 'sonnet' });
  });

  test('ignores a leftover judge or azureModel setting', {
    options: { minTokens: 0, judge: 'azure', azureModel: 'old' },
  }, async ($, on) => {
    const clock = mock.clock(on, { now: START });
    mock.env(on, HOME);
    const session = fakeSession(on);

    await $.turn.complete(finishedTurn());
    await clock.settle();

    expect(session.claudeModels).toEqual(['haiku']);
  });
});

describe('judge log lines', () => {
  const LONG_PROMPT = `START${'p'.repeat(500)}`;
  const LONG_ANSWER = `${'a'.repeat(500)}END`;

  test('a yes carries the start of the prompt and the cut end of the answer', {
    options: { minTokens: 0 },
  }, async ($, on) => {
    const clock = mock.clock(on, { now: START });
    mock.env(on, HOME);
    const session = fakeSession(on);
    session.messages = [{ role: 'user', text: LONG_PROMPT, toolUses: [] }];

    await $.turn.complete({ ...finishedTurn(), answer: LONG_ANSWER });
    await clock.settle();

    const line = loggedLines(session)[0];

    expect(line).toMatchObject({ event: 'judge-yes', tokens: 0, reason: 'work is done', model: 'haiku' });
    expect(line?.['prompt']).toBe(LONG_PROMPT.slice(0, 300));
    expect(line?.['answer']).toBe(`…${LONG_ANSWER.slice(-400)}`);
  });

  test('a no carries a short prompt and a short answer whole', { options: { minTokens: 0 } }, async ($, on) => {
    const clock = mock.clock(on, { now: START });
    mock.env(on, HOME);
    const session = fakeSession(on);
    session.claudeReply = () => claudeVerdict(false, 'mid-fix');

    await $.turn.complete(finishedTurn());
    await clock.settle();

    expect(loggedLines(session)[0]).toMatchObject({
      event: 'judge-no',
      prompt: 'Fix the bug.',
      answer: 'Done. Shall I push?',
    });
  });
});

describe('judge errors', () => {
  test('a model call that throws is logged and nothing compacts', { options: { minTokens: 0 } }, async ($, on) => {
    const clock = mock.clock(on, { now: START });
    mock.env(on, HOME);
    const session = fakeSession(on);
    session.claudeReply = () => {
      throw new Error('model offline');
    };

    await $.turn.complete(finishedTurn());
    await clock.settle();

    expect(loggedLines(session)[0]).toMatchObject({ event: 'judge-error' });
    expect(session.statuses.at(-1)).toMatch(/^error \d\d:\d\d$/);
    expect(session.compacts).toEqual([]);
  });

  test('a reply that is no verdict is a judge error', { options: { minTokens: 0 } }, async ($, on) => {
    const clock = mock.clock(on, { now: START });
    mock.env(on, HOME);
    const session = fakeSession(on);
    session.claudeReply = () => ({ isAnswered: true, text: 'I think so', usage: noUsage() });

    await $.turn.complete(finishedTurn());
    await clock.settle();

    expect(loggedEvents(session)).toEqual(['judge-error']);
    expect(session.compacts).toEqual([]);
  });

  test('a Claude judge without an answer is a judge error', { options: { minTokens: 0 } }, async ($, on) => {
    const clock = mock.clock(on, { now: START });
    mock.env(on, HOME);
    const session = fakeSession(on);
    session.claudeReply = () => ({ isAnswered: false, reason: 'empty-reply', usage: noUsage() });

    await $.turn.complete(finishedTurn());
    await clock.settle();

    expect(loggedLines(session)[0]).toMatchObject({
      event: 'judge-error',
      message: 'model gave no answer: empty-reply',
    });
  });
});

function noUsage() {
  return { input_tokens: 0, output_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 };
}

describe('first turn of a session', () => {
  const START_ARGS = { cwd: 'C:/work', surface: 'terminal', isInteractive: true } as const;
  const DAY_MS = 24 * 60 * 60 * 1000;

  test('shows the full floor at start, skips the first turn, then counts from it', async ($, on) => {
    const clock = mock.clock(on, { now: START });
    mock.env(on, HOME);
    const session = fakeSession(on);

    session.messages = [];
    session.tokens = 80000;
    await $.session.start(START_ARGS);

    expect(session.statuses).toEqual(['judge in 60k']);

    await $.turn.complete(finishedTurn('turn-1'));
    await clock.settle();

    expect(session.claudeModels).toEqual([]);
    expect(loggedLines(session)).toMatchObject([{ event: 'judge-skipped', reason: 'first turn of session' }]);

    session.tokens = 120000;
    await $.turn.complete(finishedTurn('turn-2'));
    await clock.settle();

    expect(session.statuses.at(-1)).toBe('judge in 20k');

    session.tokens = 140000;
    await $.turn.complete(finishedTurn('turn-3'));
    await clock.settle();

    expect(session.claudeModels).toEqual(['haiku']);
  });

  test('a resumed session with saved state keeps its baseline and shows the right countdown', async ($, on) => {
    mock.clock(on, { now: START });
    mock.env(on, HOME);
    const saved = { 'session-1': { baseline: 80000, waitingFor: null, savedAt: START } };
    const session = fakeSession(on, { floors: saved });

    session.tokens = 110000;
    await $.session.start(START_ARGS);

    expect(session.statuses).toEqual(['judge in 30k']);
  });

  test('a saved state that still waits for a first turn shows the full floor', async ($, on) => {
    mock.clock(on, { now: START });
    mock.env(on, HOME);
    const saved = { 'session-1': { baseline: 0, waitingFor: 'first turn of session', savedAt: START } };
    const session = fakeSession(on, { floors: saved });

    session.tokens = 90000;
    await $.session.start(START_ARGS);

    expect(session.statuses).toEqual(['judge in 60k']);
  });

  test('saved state wins over an empty conversation', async ($, on) => {
    mock.clock(on, { now: START });
    mock.env(on, HOME);
    const saved = { 'session-1': { baseline: 80000, waitingFor: null, savedAt: START } };
    const session = fakeSession(on, { floors: saved });

    session.messages = [];
    session.tokens = 100000;
    await $.session.start(START_ARGS);

    expect(session.statuses).toEqual(['judge in 40k']);
  });

  test('a resumed session with messages and no saved state counts from 0', async ($, on) => {
    mock.clock(on, { now: START });
    mock.env(on, HOME);
    const session = fakeSession(on);

    session.tokens = 100000;
    await $.session.start(START_ARGS);

    expect(session.statuses).toEqual(['judge after next turn']);
  });

  test('a /clear ends the session without a start, so its next turn is skipped as a first turn', async ($, on) => {
    const clock = mock.clock(on, { now: START });
    mock.env(on, HOME);
    const saved = { 'session-1': { baseline: 10000, waitingFor: null, savedAt: START } };
    const session = fakeSession(on, { floors: saved });

    session.tokens = 90000;
    await $.session.start(START_ARGS);
    await $.session.end({ reason: 'clear', sessionId: 'session-1', resume: { id: 'session-1' } });
    await $.turn.complete(finishedTurn());
    await clock.settle();

    expect(session.claudeModels).toEqual([]);
    expect(loggedLines(session)).toMatchObject([{ event: 'judge-skipped', reason: 'first turn of session' }]);
  });

  test('saves the baseline when the first turn is taken', async ($, on) => {
    const clock = mock.clock(on, { now: START });
    mock.env(on, HOME);
    const session = fakeSession(on);

    session.messages = [];
    session.tokens = 80000;
    await $.session.start(START_ARGS);
    await $.turn.complete(finishedTurn());
    await clock.settle();

    expect(session.store.get('floors')).toEqual({
      'session-1': { baseline: 80000, waitingFor: null, savedAt: START },
    });
  });

  test('drops saved entries older than 30 days when it writes', async ($, on) => {
    const clock = mock.clock(on, { now: START });
    mock.env(on, HOME);
    const stored = {
      floors: {
        old: { baseline: 1, waitingFor: null, savedAt: START - 31 * DAY_MS },
        recent: { baseline: 2, waitingFor: null, savedAt: START - 29 * DAY_MS },
      },
    };
    const session = fakeSession(on, stored);

    session.messages = [];
    session.tokens = 80000;
    await $.session.start(START_ARGS);
    await $.turn.complete(finishedTurn());
    await clock.settle();

    expect(Object.keys(session.store.get('floors') as object).sort()).toEqual(['recent', 'session-1']);
  });
});
