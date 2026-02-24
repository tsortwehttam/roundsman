# 🔁 roundsman

A single-file REPL for managing AI agents across multiple projects. No tabs, no fancy CLI frameworks — just a round-robin loop that lets you dispatch work to Claude across your filesystem while you keep moving.

## Why this

If you already use tools like Aider, Cursor Background Agents, or GitHub Copilot Coding Agent, roundsman is a different shape: a local, terminal-first round-robin across many repos in one place. It is less about replacing those systems and more about giving you a lightweight way to coordinate many small concurrent tasks with explicit turn-taking and per-project state.

## How it works

1. Drop one of these marker files in any project directory: `roundsman.json`, `roundsman`, `.roundsman`
2. Run `roundsman` — it scans your home directory (or a path you specify) for those files
3. For each project, you see its status and decide what to do
4. When you tell a project to work, an agent spawns in the background
5. While it works, you move to the next project

Agents run as `claude -p` with full tool access. Optional git checkpoints can be enabled in global config.

## Install

```bash
npm install -g .
```

Requires [Claude Code](https://docs.anthropic.com/en/docs/claude-code) (`claude` CLI) and Node 18+.

From this repo directory, that command installs `roundsman` globally on your system. Verify with:

```bash
which roundsman
roundsman --help
```

## Quickstart

```bash
mkdir -p ~/Code/my-project
touch ~/Code/my-project/roundsman
roundsman ~/Code
```

## Global config

Optional global defaults live at:

- `~/.roundsman/config.json`
- or `$XDG_CONFIG_HOME/roundsman/config.json` when `XDG_CONFIG_HOME` is set

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
  "checkpoint": { "enabled": false, "preTurn": true, "postTurn": true, "autoInitGit": false },
  "claudeBin": "claude",
  "ui": { "showFullPath": true, "previewChars": 200 }
}
```

Notes:

- `defaultModel` maps to `claude --model <value>`
- `apiKeyEnvVar` tells roundsman which env var to read and forward as `ANTHROPIC_API_KEY`
- Prefer environment variables for keys; do not store raw keys in config files
- Git behavior is opt-in: set `checkpoint.enabled: true` to enable checkpoints
- `checkpoint.autoInitGit` controls whether roundsman should initialize git when a project is not already in a git worktree

## Usage

```
roundsman [path]
```

Scans `path` (default: `~`) for directories containing `roundsman.json`, `roundsman`, or `.roundsman`. For each project, you get a prompt:

```
──────────────────────────────────────────────────────────
  my-project  (/Users/you/Code/my-project)
──────────────────────────────────────────────────────────
  context: A web app for tracking habits
  todos:   add dark mode | fix login bug
  turn:    3

  command (/work, /snooze, /drop, /quit) >
```

At startup, roundsman prints effective config + the projects in round-robin order, then waits for enter before the loop begins.

## Safety defaults

- Checkpoints are off by default (`checkpoint.enabled: false`)
- Git auto-init is off by default (`checkpoint.autoInitGit: false`)
- Checkpoints are scoped to the project path inside a repo, not the entire repo
- `/stop` stops active loops only
- `/kill` is explicit and stops any running agent

### Commands

| Command | What it does |
|---------|--------------|
| `/work` | Prompt for a task, spawn a background agent |
| `/loop N goal` | Repeat `goal` up to `N` turns (stops early on error) |
| `/stop [project|all]` | Stop active loop for current project, target project, or all |
| `/kill [project|all]` | Kill a running agent (loop or non-loop) |
| `/loops` | List active loops |
| `/usage` or `/cost` | Show total and per-project session cost |
| `/model [name]` | Show/set runtime model override (`none` clears) |
| `/drop` | Remove this project for the rest of this run |
| `/snooze N` | Pause this project for `N` (`s/m/h/d`, default unit minutes) |
| `/fresh` or `/clear` | Reset session — clear history, new conversation |
| `/view` | Show the full result of the last agent turn |
| `/log` | Show all turn history (timestamps, costs, I/O) |
| `/revert` | Git revert the last agent turn |
| `/quit` | Kill running agents and exit |
| `/status` | Show all projects and their states |

Pressing enter defaults to `/work`.

## Project marker files

Any of these files marks a project for roundsman:

- `roundsman.json`
- `roundsman`
- `.roundsman`

Blank files and `{}` are valid.

Example `roundsman.json`:

```json
{
  "prompt": "Short description of this project",
  "todos": ["thing to do"],
  "doing": [],
  "done": []
}
```

All fields are optional. You can add arbitrary keys as metadata — they'll be shown to you and passed to the agent.

Set `"lock": true` to skip a project without removing the file.

### Session state

Roundsman tracks session state automatically in the `session` field:

- `sessionId` — UUID for Claude conversation continuity across turns
- `turn` — turn counter
- `summary` — last agent output (shown on project display)
- `history` — last 20 turns with timestamps, costs, inputs, and results

You don't need to set any of these — they're managed by roundsman.

## How agents work

Each agent turn:

1. Optionally checkpoints dirty state if git checkpoints are enabled
2. Builds a prompt from your project marker file context + your input
3. Runs `claude -p --output-format json --permission-mode acceptEdits`
4. On first turn, sets a session ID; on subsequent turns, resumes the conversation
5. Parses the result, updates project state, and optionally checkpoints again

Agents run in the background. You get a notification when they finish:

```
  [done] my-project ($0.0234)
         Added dark mode toggle to settings page. Updated CSS variables...
```

## License

MIT
