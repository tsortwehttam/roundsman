# roundsman

I built `roundsman` because I found multi-project agent work noisy and exhausting. Too many tabs, too many terminals, too much context-switching overhead.

I wanted one place where I could:

- queue up several projects,
- hand work to agents in each project,
- keep moving while they run,
- and get pulled back through projects in a clean round-robin loop.

That is what this tool is.

## Why Round-Robin Agent Work

When you run one agent at a time, your focus often gets trapped in waiting.
When you run many agents in ad-hoc tabs, you lose track of state.

Round-robin is a practical middle path:

- Each project gets a turn.
- Background agents keep progressing while you make decisions elsewhere.
- You always return to a single prompt with explicit project context.
- Session state is persisted per project, so the loop stays coherent over time.

`roundsman` does not try to replace your editor or agent tooling. It is an orchestration layer for people who are already coding with agents and want a calmer control surface.

## What It Does

- Scans for project markers: `roundsman.json`, `roundsman`, `.roundsman`
- Builds a round-robin queue across discovered projects
- Spawns Claude Code agents in project directories (`claude -p` stream mode)
- Tracks per-project session continuity (`sessionId`, turn history, summary)
- Supports reusable per-project macros
- Supports loops for repeated objectives (`/loop` + `/stop`)
- Supports manual control of running work (`/kill`, `/snooze`, `/drop`, `/skip`)
- Shows recent cross-project live activity via `/activity`
- Optionally creates git checkpoints before/after turns

## Requirements

- Node.js `>= 18`
- [Claude Code CLI](https://docs.anthropic.com/en/docs/claude-code) available as `claude`

Quick checks:

```bash
node -v
claude --version
```

## Install

From this repository:

```bash
npm install -g .
```

Verify:

```bash
which roundsman
roundsman --help
```

For local development without global install:

```bash
node roundsman.js --help
```

## Quickstart

Create or mark projects:

```bash
roundsman add ~/Code/my-project
roundsman init ~/Code/another-project
```

Run on a root path:

```bash
roundsman ~/Code
```

Or run with default scan roots (configured globally, or home directory if unset):

```bash
roundsman
```

## CLI Usage

```bash
roundsman [path]
roundsman add [dir]
roundsman init [dir]
roundsman list [path]
roundsman [path] --dry-run
roundsman [path] --json
roundsman [path] --no-color
roundsman --help
```

Behavior:

- `list` scans and exits
- `--dry-run` scans and prints without entering REPL
- `--json` emits machine-readable scan output
- `--no-color` disables ANSI output (`NO_COLOR` is also respected)

## REPL Commands

Any plain text input is treated as `/work <text>`.
Pressing enter on an empty prompt defaults to `/work` and asks for task text.

| Command | What it does |
|---|---|
| `/work` | Prompt for a task and spawn a background agent |
| `/macro [list]` | List saved macros for current project |
| `/macro save <name> <prompt>` | Save/update a macro |
| `/macro show <name>` | Show macro text |
| `/macro run <name> [extra]` | Run macro, optionally with extra instruction |
| `/macro rm <name>` | Delete macro |
| `/loop <n> <goal>` | Run the same goal up to `n` turns |
| `/stop [project|all]` | Stop active loop(s) |
| `/kill [project|all]` | Kill running agent(s), loop or non-loop |
| `/loops` | Show active loops |
| `/usage` or `/cost` | Show total and per-project cost |
| `/model [name|none]` | Set or clear runtime model override |
| `/skip [n]` | Move current project behind `n` idle turns |
| `/snooze <n>[s|m|h|d]` | Snooze current project |
| `/drop` | Drop current project for this run |
| `/fresh` or `/clear` | Reset current project session |
| `/view` | Show full last result for current project |
| `/log` | Show turn history for current project |
| `/activity [n]` | Show recent cross-project live agent output/events |
| `/revert` | Revert last roundsman git turn commit |
| `/status` | Show all project states (including dropped) |
| `/help` | Show command help |
| `/quit` | Stop running agents and exit |
| `!<shell command>` | Run shell command in current project directory |

Aliases: `q` (quit), `s` (drop), `w` (work), `m` (macro), `f` (fresh), `v` (view), `l` (log), `a` (activity), `r` (revert), `cost` (usage), `clear` (fresh).

## Project Marker Files

Any of the following marks a directory as a roundsman project:

- `roundsman.json`
- `roundsman`
- `.roundsman`

Blank files and `{}` are valid.

Example marker:

```json
{
  "prompt": "Short description of this project",
  "todos": ["thing to do"],
  "doing": [],
  "done": [],
  "macros": {
    "audit": "Review open changes for bugs, regressions, and missing tests."
  }
}
```

Notes:

- Arrays default to empty arrays.
- Unknown keys are preserved and passed into prompt metadata.
- `"lock": true` skips project discovery for that marker.

## Session State

`roundsman` manages `session` automatically in each marker file:

- `sessionId`: UUID for conversation continuity
- `turn`: turn counter
- `summary`: recent summary
- `history`: bounded turn history (`maxHistory`)

You generally should not edit this by hand.

## Global Config

Global config location:

- `~/.roundsman/config.json`
- or `$XDG_CONFIG_HOME/roundsman/config.json`

Example:

```json
{
  "scanRoots": ["~/Code/Personal", "~/Code/Work"],
  "ignoreDirs": ["node_modules", "dist"],
  "maxDepth": 10,
  "maxHistory": 20,
  "defaultModel": "claude-sonnet-4-5",
  "apiKeyEnvVar": "ROUNDSMAN_ANTHROPIC_API_KEY",
  "defaultPermissionMode": "acceptEdits",
  "defaultCommandStyle": "slash",
  "checkpoint": {
    "enabled": false,
    "preTurn": true,
    "postTurn": true,
    "autoInitGit": false
  },
  "claudeBin": "claude",
  "ui": {
    "showFullPath": true,
    "previewChars": 200
  }
}
```

Key settings:

- `scanRoots`: default roots when no path arg is provided
- `ignoreDirs`: directories excluded while scanning
- `maxDepth`: scan depth limit
- `maxHistory`: retained turn history per project
- `defaultModel`: mapped to `claude --model`
- `defaultPermissionMode`: passed to Claude `--permission-mode`
- `apiKeyEnvVar`: env var to forward as `ANTHROPIC_API_KEY`
- `checkpoint.*`: git checkpoint controls
- `claudeBin`: executable name/path for Claude CLI
- `ui.previewChars`: done-message preview length

## Safety and Control Defaults

- Checkpoints are opt-in (`checkpoint.enabled: false`)
- Git auto-init is opt-in (`checkpoint.autoInitGit: false`)
- `/stop` is loop-specific
- `/kill` is explicit for terminating active agents
- Scope for git checkpoints is project path within repo

## How Agent Turns Work

Per turn, roundsman:

1. Optionally creates pre-turn git checkpoint
2. Builds a prompt from marker context + your input
3. Runs Claude in print stream-json mode with verbose streaming
4. Uses session continuity when there is successful prior history
5. Streams intermediate events into activity feed
6. Saves result/cost/history back into project marker
7. Optionally creates post-turn git checkpoint

## Recommended Workflow

A pattern I use:

1. Start roundsman on a root with 3 to 8 active projects.
2. Give each project one concrete task with `/work` or `/macro run`.
3. Use `/activity` while waiting to see what agents are doing across the board.
4. Use `/view` or `/log` for deep dives on a specific project.
5. Use `/snooze`, `/skip`, and `/drop` to keep the queue focused.
6. Use `/loop` only for tightly scoped repeated work.

That keeps momentum high without turning your terminal into a tab jungle.

## License

MIT
