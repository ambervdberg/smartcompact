import { describe, expect, mock, test } from 'claude-code/testing';
import { SUMMARY, fakeSession, finishedTurn, loggedLines, toolResult, withoutTime } from './fake-engine.ts';

const START = Date.UTC(2026, 9, 8, 22, 0);
const HOME = { USERPROFILE: 'C:/home' };

function nudge(added: string): string {
  return `smartcompact: this conversation grew ${added} tokens since smartcompact started counting. Plan a compaction at the next good moment. Start no new subagents and let the running ones finish. Then end your answer with <smartcompact>the prompt to start the next piece with</smartcompact>. Do this also when you would wait for the user, and put your question in the tag. Leave the tag out when the user must confirm an action that is hard to undo, such as a push, a delete or a publish.`;
}

function nudgeLines(session: ReturnType<typeof fakeSession>) {
  return loggedLines(session).filter((line) => line['event'] === 'nudge-sent');
}

describe('compact nudge', () => {
  test('sends no nudge below the floor', async ($, on) => {
    const clock = mock.clock(on, { now: START });
    mock.env(on, HOME);
    const session = fakeSession(on);

    session.tokens = 59000;
    await $.session.append(toolResult());
    await clock.settle();

    expect(session.notes).toEqual([]);
  });

  test('nudges once the floor is passed', async ($, on) => {
    const clock = mock.clock(on, { now: START });
    mock.env(on, HOME);
    const session = fakeSession(on);

    session.tokens = 61500;
    await $.session.append(toolResult());
    await clock.settle();

    expect(session.notes).toEqual([nudge('61k')]);
    expect(nudgeLines(session)).toEqual([expect.objectContaining({ tokens: 61500, added: 61500, nudge: 1 })]);
    expect(withoutTime(session.statuses.at(-1))).toBe('nudged');
  });

  test('nudges again only after half a floor more', async ($, on) => {
    const clock = mock.clock(on, { now: START });
    mock.env(on, HOME);
    const session = fakeSession(on);

    session.tokens = 61000;
    await $.session.append(toolResult());
    session.tokens = 90999;
    await $.session.append(toolResult());
    await clock.settle();

    expect(session.notes).toHaveLength(1);

    session.tokens = 91000;
    await $.session.append(toolResult());
    await clock.settle();

    expect(session.notes).toEqual([nudge('61k'), nudge('91k')]);
    expect(nudgeLines(session).map((line) => line['nudge'])).toEqual([1, 2]);
  });

  test('waits at least 10k between nudges', { options: { minTokens: 0 } }, async ($, on) => {
    const clock = mock.clock(on, { now: START });
    mock.env(on, HOME);
    const session = fakeSession(on);

    session.tokens = 1000;
    await $.session.append(toolResult());
    session.tokens = 10999;
    await $.session.append(toolResult());
    await clock.settle();

    expect(session.notes).toHaveLength(1);

    session.tokens = 11000;
    await $.session.append(toolResult());
    await clock.settle();

    expect(session.notes).toHaveLength(2);
  });

  test('a subagent tool result never nudges', async ($, on) => {
    const clock = mock.clock(on, { now: START });
    mock.env(on, HOME);
    const session = fakeSession(on);

    session.tokens = 70000;
    await $.session.append(toolResult('agent-1'));
    await clock.settle();

    expect(session.notes).toEqual([]);
  });

  test('sends no nudge without a token count', { options: { minTokens: 0 } }, async ($, on) => {
    const clock = mock.clock(on, { now: START });
    mock.env(on, HOME);
    const session = fakeSession(on);

    session.tokens = undefined;
    await $.session.append(toolResult());
    await clock.settle();

    expect(session.notes).toEqual([]);
    expect(loggedLines(session)).toMatchObject([{ event: 'usage-missing', hook: 'session.append' }]);
  });

  test('sends no nudge while the floor waits for its first turn', async ($, on) => {
    const clock = mock.clock(on, { now: START });
    mock.env(on, HOME);
    const session = fakeSession(on);

    session.messages = [];
    await $.session.start({ cwd: 'C:/work', surface: 'terminal', isInteractive: true });
    session.tokens = 70000;
    await $.session.append(toolResult());
    await clock.settle();

    expect(session.notes).toEqual([]);
  });

  test('starts the count over after a compaction', async ($, on) => {
    const clock = mock.clock(on, { now: START });
    mock.env(on, HOME);
    const session = fakeSession(on);

    session.tokens = 61000;
    await $.session.append(toolResult());
    await $.session.compact({ trigger: 'manual', messages: [SUMMARY] });
    session.tokens = 70000;
    await $.session.append(toolResult());
    await clock.settle();

    expect(session.notes).toHaveLength(1);

    session.tokens = 20000;
    await $.turn.complete(finishedTurn());
    await clock.settle();
    session.tokens = 81000;
    await $.session.append(toolResult());
    await clock.settle();

    expect(session.notes).toEqual([nudge('61k'), nudge('61k')]);
    expect(nudgeLines(session).map((line) => line['nudge'])).toEqual([1, 1]);
  });

  test('starts the count over after a /clear and its first turn', async ($, on) => {
    const clock = mock.clock(on, { now: START });
    mock.env(on, HOME);
    const session = fakeSession(on);

    session.tokens = 61000;
    await $.session.append(toolResult());
    await $.session.end({ reason: 'clear', sessionId: 'session-1', resume: { id: 'session-1' } });
    session.tokens = 5000;
    await $.turn.complete(finishedTurn());
    await clock.settle();
    session.tokens = 70000;
    await $.session.append(toolResult());
    await clock.settle();

    expect(nudgeLines(session).map((line) => line['nudge'])).toEqual([1, 1]);
  });

  test('a new baseline restarts the count even when the first turn had no tool result', { options: { minTokens: 0 } }, async ($, on) => {
    const clock = mock.clock(on, { now: START });
    mock.env(on, HOME);
    const session = fakeSession(on);

    session.tokens = 20000;
    await $.session.append(toolResult());
    await $.session.compact({ trigger: 'manual', messages: [SUMMARY] });
    session.tokens = 1000;
    await $.turn.complete(finishedTurn());
    await clock.settle();
    session.tokens = 25000;
    await $.session.append(toolResult());
    await clock.settle();

    expect(nudgeLines(session).map((line) => line['nudge'])).toEqual([1, 1]);
  });

  test('a session start restarts the count', async ($, on) => {
    const clock = mock.clock(on, { now: START });
    mock.env(on, HOME);
    const session = fakeSession(on);

    session.tokens = 61000;
    await $.session.append(toolResult());
    await $.session.start({ cwd: 'C:/work', surface: 'terminal', isInteractive: true });
    session.tokens = 91000;
    await $.session.append(toolResult());
    await clock.settle();

    expect(nudgeLines(session).map((line) => line['nudge'])).toEqual([1, 1]);
  });

  test('the nudge is stored before the append call returns', async ($, on) => {
    mock.clock(on, { now: START });
    mock.env(on, HOME);
    const session = fakeSession(on);

    session.tokens = 61000;
    await $.session.append(toolResult());

    expect(session.notes).toEqual([nudge('61k')]);
  });

  test('two tool results stored at once send one nudge', async ($, on) => {
    const clock = mock.clock(on, { now: START });
    mock.env(on, HOME);
    const session = fakeSession(on);

    session.tokens = 61000;
    await Promise.all([$.session.append(toolResult(undefined, 'row-1')), $.session.append(toolResult(undefined, 'row-2'))]);
    await clock.settle();

    expect(session.notes).toHaveLength(1);
  });

  test('a refused nudge is logged and the tool result is still stored', async ($, on) => {
    const clock = mock.clock(on, { now: START });
    mock.env(on, HOME);
    const session = fakeSession(on);

    session.tokens = 61000;
    session.noteDeny = 'policy says no';
    const stored = await $.session.append(toolResult());
    await clock.settle();

    expect(stored.uuid).toBe('row-1');
    expect(session.notes).toEqual([]);
    expect(loggedLines(session)).toContainEqual(expect.objectContaining({ event: 'nudge-error', message: 'policy says no' }));
  });
});
