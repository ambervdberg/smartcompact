import type { AgentStatus } from 'claude-code';
import type { Engine } from './engine.ts';

// `waiting` covers an agent that stopped but still waits on background work of its own.
const BUSY_STATUSES: readonly AgentStatus[] = ['pending', 'running', 'waiting'];
// The engine can keep a finished agent busy for hours. An agent quiet this long no longer blocks a compaction.
const STALE_AFTER_MS = 15 * 60 * 1000;

// Looking the folder up lists every project folder, so it is done once per session. A miss is not kept: the folder
// may appear with the first subagent.
let cachedFolder: { sessionId: string; path: string } | undefined;

/**
 * Ids of the session's subagents and teammates that still work. The engine status picks the candidates. A candidate
 * whose meta file says finished, or whose transcript is quiet for 15 minutes, does not count. Files that cannot be
 * found or read leave the engine status in charge.
 */
export async function runningSubagentIds(engine: Engine): Promise<string[]> {
  const agents = (await engine.agents()).filter((agent) => BUSY_STATUSES.includes(agent.status));

  if (agents.length === 0) {
    return [];
  }

  const folder = await subagentsFolder(engine).catch(() => undefined);

  if (folder === undefined) {
    return agents.map((agent) => agent.id);
  }

  const now = await engine.now();
  const running: string[] = [];

  for (const agent of agents) {
    const base = `${folder}/agent-${agent.id}`;

    if (!(await isMarkedFinished(engine, `${base}.meta.json`)) && !(await isStale(engine, `${base}.jsonl`, now))) {
      running.push(agent.id);
    }
  }

  return running;
}

// A missing file or broken JSON is no proof that the agent stopped.
async function isMarkedFinished(engine: Engine, metaPath: string): Promise<boolean> {
  try {
    const meta: unknown = JSON.parse(await engine.fs.read(metaPath));

    return typeof meta === 'object' && meta !== null && (meta as { finished?: unknown }).finished === true;
  } catch {
    return false;
  }
}

async function isStale(engine: Engine, transcriptPath: string, now: number): Promise<boolean> {
  try {
    const transcript = await engine.fs.stat(transcriptPath);

    return now - transcript.mtimeMs >= STALE_AFTER_MS;
  } catch {
    return false;
  }
}

// The project folder name is not derived from the cwd, because the session may have moved since it started.
async function subagentsFolder(engine: Engine): Promise<string | undefined> {
  const sessionId = await engine.sessionId();

  if (cachedFolder?.sessionId === sessionId) {
    return cachedFolder.path;
  }

  cachedFolder = undefined;
  const home = (await engine.env.userProfile()) || (await engine.env.home()) || '';
  const configDir = (await engine.env.configDir()) || `${home}/.claude`;
  const projects = `${configDir}/projects`;

  for (const entry of await engine.fs.list(projects)) {
    const path = `${projects}/${entry.name}/${sessionId}/subagents`;

    if (entry.kind === 'dir' && (await engine.fs.exists(path))) {
      cachedFolder = { sessionId, path };

      return path;
    }
  }

  return undefined;
}
