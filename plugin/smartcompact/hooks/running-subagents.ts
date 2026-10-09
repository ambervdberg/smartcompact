import type { AgentStatus } from 'claude-code';
import type { Engine } from './engine.ts';

// `waiting` covers an agent that stopped but still waits on background work of its own.
const BUSY_STATUSES: readonly AgentStatus[] = ['pending', 'running', 'waiting'];

/** Ids of the session's subagents and teammates that still work. */
export async function runningSubagentIds(engine: Engine): Promise<string[]> {
  const agents = await engine.agents();

  return agents.filter((agent) => BUSY_STATUSES.includes(agent.status)).map((agent) => agent.id);
}
