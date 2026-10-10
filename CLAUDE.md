# CLAUDE.md

## Smartcompact plugin

A Claude Code mod (a plugin with function hooks) in `plugin/smartcompact` (Claude Code 2.1.289+). After each main turn a judge
model decides whether to compact. On yes it compacts, then sends a continue prompt. Its README covers behaviour,
options and development.

- The repo root is a plugin marketplace (`.claude-plugin/marketplace.json`). The plugin installs as
  `smartcompact@smartcompact`. When the marketplace is added from a local folder, edits take effect in new sessions.
- Log: `~/.claude/smartcompact/log.jsonl`, `SMARTCOMPACT_LOG` overrides it.

## Commands

In `plugin/smartcompact`:

- `claude plugin validate .`
- `npx -p typescript tsc -p .`
- `claude plugin test .`
- Live test with the floor off: `claude --plugin-dir <repo>/plugin/smartcompact --settings '{"pluginConfigs":{"smartcompact":{"options":{"minTokens":0}}}}'`

## Flow in `plugin/smartcompact/hooks/`

- `register.ts` wires the events. It binds `$` into an `Engine` (`engine.ts`), because `claude plugin validate`
  refuses `$` passed as an argument.
- After a main turn, `compact-request.ts` reads the `<smartcompact>` tag. A tagged turn goes to `request-following.ts`,
  any other to `turn-judging.ts`.
- `compact-nudge.ts` adds a hidden nudge row after a main tool result once the floor is passed, and again every half
  floor (at least 10k), so the session ends a turn with the tag. `register.ts` runs it from `session.append`.
- A yes waits in `pending-compaction.ts` for an empty prompt box and no dialog, compacts, restarts the floor, then
  runs `continue-prompt-submit.ts`.
- Tests run against `tests/fake-engine.ts`, a stand-in engine.

## Gotchas

- Look for an engine call in the plugin API types (`.claude-plugin/types/claude-code/index.d.ts`, written when Claude
  Code loads the plugin from a folder) before working around Claude Code.
- A compaction the plugin starts does not run its own `session.compact` hook. Put after-compaction work in
  `pending-compaction.ts`.
- A background session (`claude agents --json` shows `kind: background`) keeps the plugin code it loaded at start.
  `/exit` and `--resume` do not reload it. `claude respawn <id>` does.
- The engine shows `$.ui.status` text as `⚠ smartcompact: <text>`. Do not add the plugin name.
- The first turn after a compaction is never judged, else a low floor loops: compact, continue, compact. The first turn
  of a new session is not judged either, because its startup context (about 80k) is not work done. A resume without
  saved floor state counts as a new session. The plugin README (Token floor) has the full rules.
- A `/clear` fires `session.end` with reason `clear` and no `session.start`. `register.ts` resets the floor in
  `session.end`.
- `$.session.usage().context.tokens` is undefined until the first response after a new session or a compaction. Read
  it with `contextTokens()` (`context-tokens.ts`) and skip the work on undefined. Read as 0 it sets a baseline of 0.
- API gaps: `$.fs` has no append (the log is read and rewritten). No idle or dialog-closed event. `$.prompt.read()`
  gives an empty draft under a dialog, a refused empty `$.prompt.fill` tells a dialog apart.
- A command from `$.command.register` runs by its bare name. The engine adds no plugin prefix, so the name itself
  starts with `smartcompact-`.
- `claude -p` cannot compact (`$.session.compact is not available in this mode`). Its first turn is a first turn of
  session, so a nudge shows only in a second turn: run again with `--resume <session id>`. Tell this error apart with
  `isUnavailableInThisMode()` (`mode-unavailable.ts`). Such a compaction is dropped, a judge skips and a tag request is ignored, all with no error status.
- The test kit skips a test hook that throws, and the call then fails with `no implementation for <event>`. A test
  that needs the engine's own error text uses `tests/stub-engine.ts`.
