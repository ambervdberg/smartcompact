import { expect, test } from 'claude-code/testing';
import { logEvent, newestPartOf } from '../hooks/event-log.ts';
import { settleStub, stubEngine, stubLoggedLines } from './stub-engine.ts';

test('newestPartOf measures UTF-8 bytes and keeps whole newest lines', () => {
  const line = '😀'.repeat(100) + '\n';
  const log = line.repeat(6000);
  const kept = newestPartOf(log);
  expect(kept).toBe(line.repeat(Math.floor(1_000_000 / 401)));
});

test('newestPartOf drops an oversized line without a newline', () => {
  expect(newestPartOf('x'.repeat(2_000_001))).toBe('');
});

test('newestPartOf leaves a small Unicode log unchanged', () => {
  expect(newestPartOf('é\n😀\n')).toBe('é\n😀\n');
});

test('only logging truncates error messages', async () => {
  const { engine, record } = stubEngine({});
  logEvent(engine, 'judge-error', { message: 'x'.repeat(250) });
  await settleStub();
  expect(stubLoggedLines(record)[0]?.['message']).toBe('x'.repeat(200));
});
