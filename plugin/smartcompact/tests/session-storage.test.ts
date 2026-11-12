import { expect, mock, test } from 'claude-code/testing';
import type { Engine as TestEngine } from 'claude-code/testing';
import { ContextFloor } from '../hooks/context-floor.ts';
import type { Engine } from '../hooks/engine.ts';
import { logEvent } from '../hooks/event-log.ts';
import { loadFloorState, saveFloorState } from '../hooks/floor-store.ts';
import { choicesFilePath, logFilePath } from '../hooks/log-paths.ts';
import { FAKE_HOME, fakeSession } from './fake-engine.ts';

const NOW = Date.UTC(2026, 9, 10);
const DAY = 24 * 60 * 60 * 1000;
const FOLDER = `${FAKE_HOME}/.claude/smartcompact`;

function storageEngine($: TestEngine, id: string): Engine {
  return {
    now: () => $.clock.now(),
    sessionId: async () => id,
    cwd: () => $.session.cwd(),
    fs: {
      exists: (path: string) => $.fs.exists(path),
      read: (path: string) => $.fs.read(path),
      write: (path: string, text: string) => $.fs.write(path, text),
    },
    store: {
      get: (key: string) => $.store.get(key),
      set: (key: string, value: unknown) => $.store.set(key, value),
      delete: (key: string) => $.store.delete(key),
    },
    env: {
      logFile: () => $.env.get('SMARTCOMPACT_LOG'),
      userProfile: () => $.env.get('USERPROFILE'),
      home: () => $.env.get('HOME'),
    },
  } as Engine;
}

test('concurrent sessions keep every log line in their own file', async ($, on) => {
  const clock = mock.clock(on, { now: NOW });
  mock.env(on, { HOME: FAKE_HOME });
  const session = fakeSession(on);
  const first = storageEngine($, 'first');
  const second = storageEngine($, 'second');

  await Promise.all([
    Promise.resolve().then(() => { logEvent(first, 'first-a'); logEvent(first, 'first-b'); }),
    Promise.resolve().then(() => { logEvent(second, 'second-a'); logEvent(second, 'second-b'); }),
  ]);
  await clock.settle();

  for (const id of ['first', 'second']) {
    const lines = (session.files.get(`${FOLDER}/logs/${id}.jsonl`) ?? '').trim().split('\n');
    expect(lines.map((line) => JSON.parse(line).event)).toEqual([`${id}-a`, `${id}-b`]);
    expect(lines.map((line) => JSON.parse(line).session)).toEqual([id, id]);
  }
});

test('concurrent sessions still share the log override', async ($, on) => {
  const clock = mock.clock(on, { now: NOW });
  const path = '/custom/events.jsonl';
  mock.env(on, { HOME: FAKE_HOME, SMARTCOMPACT_LOG: path });
  const session = fakeSession(on);
  const first = storageEngine($, 'first');
  const second = storageEngine($, 'second');

  await Promise.all([
    Promise.resolve().then(() => logEvent(first, 'first')),
    Promise.resolve().then(() => logEvent(second, 'second')),
  ]);
  await clock.settle();

  const lines = (session.files.get(path) ?? '').trim().split('\n').map((line) => JSON.parse(line));
  expect(lines.map((line) => line.session).sort()).toEqual(['first', 'second']);
  expect(await choicesFilePath(first)).toBe('/custom/choices.md');
});

test('default paths sanitize session ids and keep choices in the plugin folder', async ($, on) => {
  mock.env(on, { HOME: FAKE_HOME });
  fakeSession(on);
  const engine = storageEngine($, '../a/b:c_1-2');

  expect(await logFilePath(engine)).toBe(`${FOLDER}/logs/abc_1-2.jsonl`);
  expect(await choicesFilePath(engine)).toBe(`${FOLDER}/choices.md`);
});

test('a log write near the cap trims before the next write reads it', async ($, on) => {
  const clock = mock.clock(on, { now: NOW });
  mock.env(on, { HOME: FAKE_HOME });
  const session = fakeSession(on);
  const engine = storageEngine($, 'first');
  const path = `${FOLDER}/logs/first.jsonl`;
  session.files.set(path, ('x'.repeat(999) + '\n').repeat(300));

  logEvent(engine, 'first');
  await clock.settle();
  const after = session.files.get(path)!;
  expect(after.length <= 150_000).toBe(true);
  expect(after.endsWith('\n')).toBe(true);
  expect(JSON.parse(after.trim().split('\n').at(-1)!).event).toBe('first');
});

test('concurrent saves keep both session floors', async ($, on) => {
  mock.clock(on, { now: NOW });
  fakeSession(on);
  const first = storageEngine($, 'first');
  const second = storageEngine($, 'second');
  const floor = new ContextFloor();
  floor.restore({ baseline: 123, waitingFor: null });
  const other = new ContextFloor();
  other.restore({ baseline: 456, waitingFor: 'first turn after compaction' });

  await Promise.all([saveFloorState(first, floor), saveFloorState(second, other)]);

  expect(await loadFloorState(first, 'first')).toEqual(floor.state());
  expect(await loadFloorState(second, 'second')).toEqual(other.state());
});

test('saving prunes old index entries and their floor keys', async ($, on) => {
  mock.clock(on, { now: NOW });
  const old = { baseline: 1, waitingFor: null, savedAt: NOW - 31 * DAY };
  const recent = { ...old, savedAt: NOW - 30 * DAY };
  const session = fakeSession(on, {
    'floor:old': old,
    'floor:recent': recent,
    'floor-index': { old: old.savedAt, recent: recent.savedAt },
  });
  const engine = storageEngine($, 'current');

  await saveFloorState(engine, new ContextFloor());

  expect(session.store.has('floor:old')).toBe(false);
  expect(session.store.get('floor:recent')).toEqual(recent);
  expect(session.store.get('floor-index')).toEqual({ recent: recent.savedAt, current: NOW });
});

test('loading ignores expired and invalid floors without using legacy over an existing key', async ($, on) => {
  mock.clock(on, { now: NOW });
  fakeSession(on, {
    'floor:old': { baseline: 1, waitingFor: null, savedAt: NOW - 31 * DAY },
    'floor:invalid': { baseline: 'bad', waitingFor: null, savedAt: NOW },
    floors: { old: { baseline: 2, waitingFor: null, savedAt: NOW } },
  });
  const engine = storageEngine($, 'current');

  expect(await loadFloorState(engine, 'old')).toBeUndefined();
  expect(await loadFloorState(engine, 'invalid')).toBeUndefined();
});

test('legacy floors load read-only only when the new session key is absent', async ($, on) => {
  mock.clock(on, { now: NOW });
  const saved = { baseline: 123, waitingFor: null, savedAt: NOW };
  const session = fakeSession(on, {
    floors: { legacy: saved, expired: { ...saved, savedAt: NOW - 31 * DAY }, new: saved },
    'floor:new': { ...saved, baseline: 456 },
  });
  const engine = storageEngine($, 'legacy');

  expect(await loadFloorState(engine, 'legacy')).toEqual({ baseline: 123, waitingFor: null });
  expect(await loadFloorState(engine, 'expired')).toBeUndefined();
  expect(await loadFloorState(engine, 'new')).toEqual({ baseline: 456, waitingFor: null });
  expect(session.store.has('floor:legacy')).toBe(false);
  expect(session.store.get('floors')).toEqual({ legacy: saved, expired: { ...saved, savedAt: NOW - 31 * DAY }, new: saved });
});

test('saving a session with an expired index entry keeps its refreshed floor', async ($, on) => {
  mock.clock(on, { now: NOW });
  const session = fakeSession(on, { 'floor-index': { current: NOW - 31 * DAY } });
  const engine = storageEngine($, 'current');
  const floor = new ContextFloor();

  await saveFloorState(engine, floor);

  expect(await loadFloorState(engine, 'current')).toEqual(floor.state());
  expect(session.store.get('floor-index')).toEqual({ current: NOW });
});
