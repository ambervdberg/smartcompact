import type {
  AgentInfo,
  ModelCompleteRequest,
  ModelCompleteResult,
  On,
  PromptEditInput,
  SessionMessage,
} from 'claude-code';
import type { Engine as TestEngine } from 'claude-code/testing';

// The engine hands fs hooks the path in the platform's own spelling, so the fake keys its files with forward slashes.
const LOG_FILE = 'C:/home/.claude/smartcompact/log.jsonl';
// The fake cannot read the disk, so it serves the shipped prompt for the plugin folder under test itself.
const SHIPPED_PROMPT_TAIL = '/plugin/smartcompact/continue-prompt.md';

/** The user's own continue prompt under the fake home folder. */
export const OVERRIDE_PROMPT_FILE = 'C:/home/.claude/smartcompact/continue-prompt.md';

/** A copy of `continue-prompt.md`. Keep the two the same. */
export const SHIPPED_CONTINUE_PROMPT = [
  'Context was compacted automatically.',
  '{next}',
  '- If you were waiting on a choice from me, make the best decision and go on.',
  '- If the current task or plan has more steps, do the next one.',
  '- If all work is done, stop and say so.',
].join('\n');

export const SUMMARY: SessionMessage = { role: 'user', text: 'Summary of the work so far.', toolUses: [] };

const NO_USAGE = { input_tokens: 0, output_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 };

/** What the fake session holds and what the plugin did to it. Tests change the first part and read the second. */
export type FakeSession = {
  /** Change it to stand in for a /resume to another session in the same process. */
  id: string;
  /** Undefined stands in for the time before the first response, when the engine has no count yet. */
  tokens: number | undefined;
  draft: string;
  isDialogOpen: boolean;
  agents: AgentInfo[];
  messages: SessionMessage[];
  claudeReply: (request: ModelCompleteRequest) => ModelCompleteResult | Promise<ModelCompleteResult>;
  compactError: string | undefined;
  compactSkip: string | undefined;
  compacts: (string | undefined)[];
  submitted: string[];
  statuses: (string | undefined)[];
  claudeModels: string[];
  commands: string[];
  isCommandRefused: boolean;
  files: Map<string, string>;
  /** Paths whose read fails, as a locked or broken file would. */
  unreadableFiles: Set<string>;
  store: Map<string, unknown>;
  /** Texts of the rows the plugin appended. */
  notes: string[];
  /** When set, the plugin's own append is refused with this reason. */
  noteDeny: string | undefined;
};

/** Stands in for the engine beneath the plugin: each hook answers from the fake session. */
export function fakeSession(on: On, stored: Record<string, unknown> = {}): FakeSession {
  const session: FakeSession = {
    id: 'session-1',
    tokens: 0,
    draft: '',
    isDialogOpen: false,
    agents: [],
    messages: [{ role: 'user', text: 'Fix the bug.', toolUses: [] }],
    claudeReply: () => claudeVerdict(true, 'work is done'),
    compactError: undefined,
    compactSkip: undefined,
    compacts: [],
    submitted: [],
    statuses: [],
    claudeModels: [],
    commands: [],
    isCommandRefused: false,
    files: new Map(),
    unreadableFiles: new Set(),
    store: new Map(Object.entries(stored)),
    notes: [],
    noteDeny: undefined,
  };

  answerTurnEvents(on);
  answerSessionCalls(on, session);
  answerPromptCalls(on, session);
  answerModelCalls(on, session);
  answerFiles(on, session);
  answerStore(on, session);
  answerCommands(on, session);

  return session;
}

/** The event names the plugin wrote to its log, in order. */
export function loggedEvents(session: FakeSession): string[] {
  return loggedLines(session).map((line) => String(line['event']));
}

export function loggedLines(session: FakeSession): Record<string, unknown>[] {
  const log = session.files.get(LOG_FILE) ?? '';

  return log.split('\n').filter((line) => line !== '').map((line) => JSON.parse(line));
}

export function claudeVerdict(compact: boolean, reason: string): ModelCompleteResult {
  return { isAnswered: true, text: JSON.stringify({ compact, reason }), usage: NO_USAGE };
}

/** The person deletes the whole draft. The test kit runs `prompt.edit` but its typings leave the call out. */
export async function clearDraft($: TestEngine, draft: string): Promise<void> {
  const prompt = $.prompt as unknown as { edit: (e: PromptEditInput) => Promise<unknown> };

  const end = draft.length;

  await prompt.edit({ origin: { kind: 'composer' }, text: draft, cursor: end, start: 0, end, inputText: '' });
}

export function finishedTurn(turnId = 'turn-1') {
  return { answer: 'Done. Shall I push?', durationMs: 1000, isAborted: false, turnId, reason: 'answer' as const };
}

/** A finished main turn whose answer ends with the compact tag. */
export function taggedTurn(next: string, turnId = 'turn-1') {
  return { ...finishedTurn(turnId), answer: `The tests pass.\n<smartcompact>${next}</smartcompact>` };
}

/** Runs one model request of a turn to its end: of the main session, or of a subagent when `agentId` is given. */
export async function runStep($: TestEngine, index: number, agentId?: string): Promise<void> {
  const stream = $.turn.step({
    turnId: 'turn-1',
    index,
    model: 'opus',
    messageCount: 1,
    ...(agentId === undefined ? {} : { agentId }),
  });

  for await (const _chunk of stream) {
    // Reads the stream to its end, as the engine does.
  }
}

/** A tool result row of the main session, or of a subagent when `agentId` is given. */
export function toolResult(agentId?: string, uuid = 'row-1') {
  return {
    message: {
      type: 'user' as const,
      role: 'user' as const,
      content: [{ type: 'tool_result' as const, tool_use_id: 'tool-1', content: 'ok' }],
    },
    door: 'tool-result' as const,
    origin: { kind: 'tool' as const, tool: 'Bash' },
    uuid,
    ...(agentId === undefined ? {} : { agentId }),
  };
}

/** Runs a slash command as the person typing it at the prompt. */
export function runCommand($: TestEngine, command: string) {
  return $.command.run({
    command,
    args: '',
    origin: { kind: 'composer' },
    presentation: { isFullscreen: false, columns: 80 },
  });
}

/** A timed status without its `HH:mm`, so a test does not depend on the local time zone. */
export function withoutTime(status: string | undefined): string | undefined {
  return status?.replace(/ \d\d:\d\d$/, '');
}

function answerTurnEvents(on: On): void {
  // A response with no text and no tool calls. Only the step's start matters to the plugin.
  on('turn.step', async function* (_$, e) {
    return { turnId: e.turnId, index: e.index, answer: '', toolUses: [], stopReason: 'end_turn' as const, usage: null };
  });
  on('turn.complete', (_$, e) => ({ text: e.answer }));
  on('turn.start', (_$, e) => ({ turnId: e.turnId }));
  on('session.start', (_$, e) => ({ cwd: e.cwd }));
  on('session.end', (_$, e) => ({ sessionId: e.sessionId }));
}

function answerSessionCalls(on: On, session: FakeSession): void {
  on('ui.status', (_$, e) => {
    session.statuses.push(e.text);

    return { value: undefined };
  });
  on('session.id', () => ({ value: session.id }));
  on('session.cwd', () => ({ value: 'C:/work' }));
  on('session.usage', () => ({
    value: {
      startedAt: 0,
      context: { ...(session.tokens === undefined ? {} : { tokens: session.tokens }), window: 200000 },
      rateLimits: [],
    },
  }));
  on('session.messages', () => ({ value: session.messages }));
  on('agent.list', () => ({ value: session.agents }));
  on('session.compact', (_$, e) => {
    if (session.compactError !== undefined) {
      throw new Error(session.compactError);
    }

    if (session.compactSkip !== undefined) {
      return { skip: session.compactSkip };
    }

    session.compacts.push(e.instructions);

    return { messages: [SUMMARY] };
  });
  // The engine skips an append hook that answers without next, except with a deny.
  on('session.append', (_$, e, next) => {
    if (e.door !== 'tool-result') {
      if (session.noteDeny !== undefined) {
        return { deny: session.noteDeny };
      }

      session.notes.push(e.message.content.map((block) => ('text' in block ? block.text : '')).join(''));
    }

    return next(e);
  });
}

function answerPromptCalls(on: On, session: FakeSession): void {
  on('prompt.context', (_$, e) => ({ blocks: e.blocks }));
  on('prompt.read', () => ({ value: { text: session.draft, cursor: session.draft.length } }));
  on('prompt.fill', () =>
    session.isDialogOpen ? { isFilled: false, refusal: 'dialog' as const } : { isFilled: true });
  on('prompt.submit', (_$, e) => {
    session.submitted.push(e.text);

    return { text: e.text };
  });
  on('prompt.edit', (_$, e) => {
    session.draft = `${e.text.slice(0, e.start)}${e.inputText}${e.text.slice(e.end)}`;

    return { text: session.draft, cursor: session.draft.length };
  });
}

function answerModelCalls(on: On, session: FakeSession): void {
  on('model.complete', async (_$, e) => {
    session.claudeModels.push(e.model);

    return { value: await session.claudeReply(e) };
  });
}

// Values pass through JSON as in the engine's own store.
function answerStore(on: On, session: FakeSession): void {
  on('store.get', (_$, e) => ({ value: session.store.get(e.key) }));
  on('store.set', (_$, e) => {
    session.store.set(e.key, JSON.parse(JSON.stringify(e.value)));

    return { value: undefined };
  });
  on('store.delete', (_$, e) => {
    session.store.delete(e.key);

    return { value: undefined };
  });
}

function answerCommands(on: On, session: FakeSession): void {
  on('command.register', (_$, e) => {
    if (session.isCommandRefused) {
      throw new Error(`cannot register ${e.name}`);
    }

    session.commands.push(e.name);

    return { value: { command: e.name } };
  });
}

function answerFiles(on: On, session: FakeSession): void {
  on('fs.exists', (_$, e) => ({ value: session.files.has(slashed(e.path)) || isShippedPrompt(e.path) }));
  on('fs.read', (_$, e) => {
    if (session.unreadableFiles.has(slashed(e.path))) {
      throw new Error(`cannot read ${e.path}`);
    }

    return { value: session.files.get(slashed(e.path)) ?? (isShippedPrompt(e.path) ? SHIPPED_CONTINUE_PROMPT : '') };
  });
  on('fs.write', (_$, e) => {
    session.files.set(slashed(e.path), e.text);

    return { value: undefined };
  });
}

function slashed(path: string): string {
  return path.replaceAll('\\', '/');
}

function isShippedPrompt(path: string): boolean {
  return slashed(path).endsWith(SHIPPED_PROMPT_TAIL);
}
