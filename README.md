# Roundsman

Roundsman is a Node.js-based CLI tool thatto make it easy to work on many projects with Claude at the same time. It is kept very, stupidly, simple on purpose. I do not like windows/panels/tabs, I do not like "TUI" theatrics, and I do not like tools that I have to remember more than 2 things to use. So, here's how you use it:

1. Put a `roundsman.json` in any folder you work on with Claude Code. Blank is fine, whatever
2. Run `roundsman` from anywhere on your machine (after installing it, sir)

After a quick confirmation prompt, Roundsman will start visiting all your projects in order, in round-robin fashion. Upon each visit, you (the "engineer") are expected to give a prompt. Roundsman will send that prompt to Claude, who will do the actual work. While Claude is working, Roundsman will take you to the next available project, and so-on. If all Claudes are working, you will wait until one of the projects needs you. You'll see Claude's output(s) in the meantime.

There are a few advanced features available too - such as slash-commands, obviously. Like `/snooze 13` (to stop visiting a given project for 13 minutes), or `/drop` (to remove a project from the round robin list), or even `/loop 88 fix all the bugs` which will make it tell Claude to `"fix all the bugs"` 88 times. See below for more about commands and settings.

Congratulations, you can now code on a bajillion projects with Claude at the same time in a straightforward manner.

---

## AI-Generated README

### What It Does

- Scans for project markers: `roundsman.json`, `roundsman`, `.roundsman`
- Builds a round-robin queue across discovered projects
- Spawns Claude Code agents in project directories (`claude -p` stream mode)
- Tracks per-project session continuity (`sessionId`, turn history, summary)
- Supports reusable per-project macros
- Supports loops for repeated objectives (`/loop` + `/stop`)
- Supports manual control of running work (`/kill`, `/snooze`, `/drop`, `/skip`)
- Shows recent cross-project live activity via `/activity`
- Optionally creates git checkpoints before/after turns

### Requirements

- Node.js `>= 18`
- [Claude Code CLI](https://docs.anthropic.com/en/docs/claude-code) available as `claude`

Quick checks:

```bash
node -v
claude --version
```

### Install

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

### Quickstart

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

### CLI Usage

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

### REPL Commands

Any plain text input is treated as `/work <text>`.
Pressing enter on an empty prompt defaults to `/work` and asks for task text.

| Command | What it does |
|---|---|
| `/work` | Prompt for a task and spawn a background agent |
| `/watch` | Start this project's watch command and remove it from visits until it exits |
| `/broadcast` | Prompt for a task and run it across all idle projects |
| `/macro [list]` | List saved macros for current project |
| `/macro save <name> <prompt>` | Save/update a macro |
| `/macro show <name>` | Show macro text |
| `/macro run <name> [extra]` | Run macro, optionally with extra instruction |
| `/macro rm <name>` | Delete macro |
| `/loop <n> <goal>` | Run the same goal up to `n` turns |
| `/stop [project|all]` | Stop active loop(s) |
| `/kill [project|all]` | Kill running agent(s) and watcher process(es) |
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

### Project Marker Files

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
  "watch": "mailmaster wait --project acme",
  "hooks": {
    "afterWatchSuccess": "Read the newest unread messages and summarize what matters."
  },
  "macros": {
    "audit": "Review open changes for bugs, regressions, and missing tests."
  }
}
```

Notes:

- Arrays default to empty arrays.
- Unknown keys are preserved and passed into prompt metadata.
- `"lock": true` skips project discovery for that marker.

Hook values support two forms:
- Starts with `!` => shell command in project directory
- Otherwise => agent prompt via normal roundsman agent flow

### Session State

`roundsman` manages `session` automatically in each marker file:

- `sessionId`: UUID for conversation continuity
- `turn`: turn counter
- `summary`: recent summary
- `history`: bounded turn history (`maxHistory`)

You generally should not edit this by hand.

### Global Config

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

### Safety and Control Defaults

- Checkpoints are opt-in (`checkpoint.enabled: false`)
- Git auto-init is opt-in (`checkpoint.autoInitGit: false`)
- `/stop` is loop-specific
- `/kill` is explicit for terminating active agents
- Scope for git checkpoints is project path within repo

### How Agent Turns Work

Per turn, roundsman:

1. Optionally creates pre-turn git checkpoint
2. Builds a prompt from marker context + your input
3. Runs Claude in print stream-json mode with verbose streaming
4. Uses session continuity when there is successful prior history
5. Streams intermediate events into activity feed
6. Saves result/cost/history back into project marker
7. Optionally creates post-turn git checkpoint

### Recommended Workflow

A pattern I use:

1. Start roundsman on a root with 3 to 8 active projects.
2. Give each project one concrete task with `/work` or `/macro run`.
3. Use `/activity` while waiting to see what agents are doing across the board.
4. Use `/view` or `/log` for deep dives on a specific project.
5. Use `/snooze`, `/skip`, and `/drop` to keep the queue focused.
6. Use `/loop` only for tightly scoped repeated work.

### License

MIT
