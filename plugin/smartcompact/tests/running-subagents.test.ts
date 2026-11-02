import { describe, expect, mock, test } from 'claude-code/testing';
import { fakeSession, finishedTurn, loggedLines, seedSubagent, taggedTurn } from './fake-engine.ts';

const START = Date.UTC(2026, 9, 4, 10, 0);
const HOME = { USERPROFILE: 'C:/home' };
const NO_FLOOR = { options: { minTokens: 0 } };
const BUSY_AGENT = { id: 'worker', description: 'review', type: 'general-purpose', status: 'running' as const };

describe('subagent files override a busy engine status', () => {
  for (const source of ['tag', 'judge'] as const) {
    for (const status of ['pending', 'running', 'waiting'] as const) {
      test(`a finished ${status} agent does not block the ${source}`, NO_FLOOR, async ($, on) => {
        const clock = mock.clock(on, { now: START });
        mock.env(on, HOME);
        const session = fakeSession(on);
        session.agents = [{ ...BUSY_AGENT, status }];
        seedSubagent(session, 'worker', true, START);

        await $.turn.complete(source === 'tag' ? taggedTurn('Write the docs.') : finishedTurn());
        await clock.settle();

        expect(session.compacts).toHaveLength(1);
        expect(session.claudeModels).toEqual(source === 'judge' ? ['haiku'] : []);
        expect(session.notes).toEqual([]);
      });
    }

    for (const age of [15 * 60_000, 15 * 60_000 - 1000]) {
      test(`a transcript aged ${age / 1000}s ${age === 900000 ? 'allows' : 'blocks'} the ${source}`, NO_FLOOR, async ($, on) => {
        const clock = mock.clock(on, { now: START });
        mock.env(on, HOME);
        const session = fakeSession(on);
        session.agents = [BUSY_AGENT];
        seedSubagent(session, 'worker', false, START - age);

        await $.turn.complete(source === 'tag' ? taggedTurn('Write the docs.') : finishedTurn());
        await clock.settle();

        expect(session.compacts).toHaveLength(age === 900000 ? 1 : 0);
        if (age < 900000) {
          expect(loggedLines(session)).toContainEqual(expect.objectContaining({
            reason: 'subagents running', agents: ['worker'],
          }));
        }
      });
    }
  }

  test('honours CLAUDE_CONFIG_DIR and scans project folders', NO_FLOOR, async ($, on) => {
    const clock = mock.clock(on, { now: START });
    mock.env(on, { ...HOME, CLAUDE_CONFIG_DIR: 'D:/config' });
    const session = fakeSession(on);
    session.id = 'custom-config-session';
    session.agents = [BUSY_AGENT];
    seedSubagent(session, 'worker', false, START);
    session.files.set('D:/config/projects/unrelated/file', '');
    session.files.set('D:/config/projects/any-project/custom-config-session/subagents/agent-worker.meta.json', '{"finished":true}');

    await $.turn.complete(taggedTurn('Write the docs.'));
    await clock.settle();

    expect(session.compacts).toHaveLength(1);
  });

  test('uses HOME when USERPROFILE is absent', NO_FLOOR, async ($, on) => {
    const clock = mock.clock(on, { now: START });
    mock.env(on, { HOME: 'C:/home' });
    const session = fakeSession(on);
    session.agents = [BUSY_AGENT];
    seedSubagent(session, 'worker', true, START);

    await $.turn.complete(taggedTurn('Write the docs.'));
    await clock.settle();

    expect(session.compacts).toHaveLength(1);
  });

  for (const problem of ['broken meta', 'unreadable meta', 'missing meta', 'missing transcript'] as const) {
    test(`${problem} keeps trusting the engine status`, NO_FLOOR, async ($, on) => {
      const clock = mock.clock(on, { now: START });
      mock.env(on, HOME);
      const session = fakeSession(on);
      session.agents = [BUSY_AGENT];
      const transcript = seedSubagent(session, 'worker', false, START);
      const meta = transcript.replace('.jsonl', '.meta.json');

      if (problem === 'broken meta') session.files.set(meta, '{');
      if (problem === 'unreadable meta') session.unreadableFiles.add(meta);
      if (problem === 'missing meta') session.files.delete(meta);
      if (problem === 'missing transcript') session.files.delete(transcript);

      await $.turn.complete(taggedTurn('Write the docs.'));
      await clock.settle();

      expect(session.compacts).toEqual([]);
      expect(loggedLines(session)).toContainEqual(expect.objectContaining({ reason: 'subagents running' }));
    });
  }

  test('a stale transcript is enough when the meta file is missing', NO_FLOOR, async ($, on) => {
    const clock = mock.clock(on, { now: START });
    mock.env(on, HOME);
    const session = fakeSession(on);
    session.agents = [BUSY_AGENT];
    const transcript = seedSubagent(session, 'worker', false, START - 900000);
    session.files.delete(transcript.replace('.jsonl', '.meta.json'));

    await $.turn.complete(taggedTurn('Write the docs.'));
    await clock.settle();

    expect(session.compacts).toHaveLength(1);
  });

  test('looks again after a folder was missing', NO_FLOOR, async ($, on) => {
    const clock = mock.clock(on, { now: START });
    mock.env(on, HOME);
    const session = fakeSession(on);
    session.id = 'late-files-session';
    session.agents = [BUSY_AGENT];

    await $.turn.complete(taggedTurn('Write the docs.'));
    await clock.settle();
    expect(session.compacts).toEqual([]);

    seedSubagent(session, 'worker', true, START);
    await $.turn.complete(taggedTurn('Write the docs.', 'turn-2'));
    await clock.settle();

    expect(session.compacts).toHaveLength(1);
  });

  test('keeps the folder for one session and looks again for another', NO_FLOOR, async ($, on) => {
    const clock = mock.clock(on, { now: START });
    mock.env(on, HOME);
    const session = fakeSession(on);
    session.agents = [BUSY_AGENT];
    const transcript = seedSubagent(session, 'worker', false, START);
    const meta = transcript.replace('.jsonl', '.meta.json');

    await $.turn.complete(taggedTurn('Write the docs.'));
    await clock.settle();
    session.files.delete(meta);
    session.files.delete(transcript);
    session.files.set('C:/home/.claude/projects/other/session-1/subagents/agent-worker.meta.json', '{"finished":true}');
    await $.turn.complete(taggedTurn('Write the docs.', 'turn-2'));
    await clock.settle();
    expect(session.compacts).toEqual([]);

    session.id = 'session-2';
    session.files.set('C:/home/.claude/projects/other/session-2/subagents/agent-worker.meta.json', '{"finished":true}');
    await $.turn.complete(taggedTurn('Write the docs.', 'turn-3'));
    await clock.settle();

    expect(session.compacts).toHaveLength(1);
  });
});
