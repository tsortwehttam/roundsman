#!/usr/bin/env node

const { spawn, spawnSync } = require("child_process");
const { createInterface } = require("readline");
const { randomUUID } = require("crypto");
const fs = require("fs");
const path = require("path");
const os = require("os");

const ROUNDSMAN_FILES = ["roundsman.json", "roundsman", ".roundsman"];
const MAX_DEPTH = 10;
const MAX_HISTORY = 20;
const KNOWN_KEYS = new Set(["prompt", "todos", "doing", "lock", "done", "session"]);
const DEFAULT_GLOBAL_CONFIG = {
  scanRoots: [],
  ignoreDirs: ["node_modules"],
  maxDepth: MAX_DEPTH,
  maxHistory: MAX_HISTORY,
  defaultModel: "",
  apiKeyEnvVar: "",
  defaultPermissionMode: "acceptEdits",
  defaultCommandStyle: "slash",
  checkpoint: { enabled: false, preTurn: true, postTurn: true, autoInitGit: false },
  claudeBin: "claude",
  ui: { showFullPath: true, previewChars: 200 },
};

// ── Utilities ──────────────────────────────────────────────

function normalizeList(v) {
  if (Array.isArray(v)) return v.map((x) => String(x));
  if (v === undefined || v === null || v === "") return [];
  return [String(v)];
}

function nowIso() {
  return new Date().toISOString();
}

function git(args, cwd) {
  const r = spawnSync("git", args, { cwd, encoding: "utf-8", stdio: "pipe" });
  return { ok: !r.error && r.status === 0, stdout: r.stdout || "", stderr: r.stderr || "" };
}

function stringifyMeta(v) {
  if (Array.isArray(v)) return v.join(", ");
  if (v && typeof v === "object") return JSON.stringify(v);
  return String(v);
}

function formatJsonError(raw, err) {
  const msg = err && typeof err.message === "string" ? err.message : "invalid JSON";
  const m = msg.match(/position (\d+)/);
  if (!m) return msg;
  const pos = Number(m[1]);
  if (!Number.isInteger(pos) || pos < 0) return msg;
  const head = raw.slice(0, pos);
  const line = head.split("\n").length;
  const col = pos - head.lastIndexOf("\n");
  return `${msg} (line ${line}, col ${col})`;
}

function expandHomePath(p) {
  if (typeof p !== "string") return "";
  if (p === "~") return os.homedir();
  if (p.startsWith("~/")) return path.join(os.homedir(), p.slice(2));
  return p;
}

function resolveGlobalConfigPath() {
  if (process.env.XDG_CONFIG_HOME) {
    return path.join(process.env.XDG_CONFIG_HOME, "roundsman", "config.json");
  }
  return path.join(os.homedir(), ".roundsman", "config.json");
}

function normalizeGlobalConfig(v) {
  const raw = v && typeof v === "object" && !Array.isArray(v) ? v : {};
  const cp = raw.checkpoint && typeof raw.checkpoint === "object" && !Array.isArray(raw.checkpoint) ? raw.checkpoint : {};
  const ui = raw.ui && typeof raw.ui === "object" && !Array.isArray(raw.ui) ? raw.ui : {};
  const roots = Array.isArray(raw.scanRoots) ? raw.scanRoots : [];
  const ignores = Array.isArray(raw.ignoreDirs) ? raw.ignoreDirs : [];
  return {
    scanRoots: roots.map((x) => expandHomePath(String(x))).filter((x) => x),
    ignoreDirs: ignores.map((x) => String(x)).filter((x) => x),
    maxDepth: Number.isInteger(raw.maxDepth) && raw.maxDepth >= 0 ? raw.maxDepth : DEFAULT_GLOBAL_CONFIG.maxDepth,
    maxHistory: Number.isInteger(raw.maxHistory) && raw.maxHistory > 0 ? raw.maxHistory : DEFAULT_GLOBAL_CONFIG.maxHistory,
    defaultModel: typeof raw.defaultModel === "string" ? raw.defaultModel.trim() : DEFAULT_GLOBAL_CONFIG.defaultModel,
    apiKeyEnvVar: typeof raw.apiKeyEnvVar === "string" ? raw.apiKeyEnvVar.trim() : DEFAULT_GLOBAL_CONFIG.apiKeyEnvVar,
    defaultPermissionMode: typeof raw.defaultPermissionMode === "string" && raw.defaultPermissionMode
      ? raw.defaultPermissionMode
      : DEFAULT_GLOBAL_CONFIG.defaultPermissionMode,
    defaultCommandStyle: raw.defaultCommandStyle === "short" ? "short" : "slash",
    checkpoint: {
      enabled: cp.enabled === true,
      preTurn: cp.preTurn !== false,
      postTurn: cp.postTurn !== false,
      autoInitGit: cp.autoInitGit === true,
    },
    claudeBin: typeof raw.claudeBin === "string" && raw.claudeBin ? raw.claudeBin : DEFAULT_GLOBAL_CONFIG.claudeBin,
    ui: {
      showFullPath: ui.showFullPath !== false,
      previewChars: Number.isInteger(ui.previewChars) && ui.previewChars > 0 ? ui.previewChars : DEFAULT_GLOBAL_CONFIG.ui.previewChars,
    },
  };
}

function loadGlobalConfig() {
  const configPath = resolveGlobalConfigPath();
  if (!fs.existsSync(configPath)) return { config: normalizeGlobalConfig(DEFAULT_GLOBAL_CONFIG), configPath, exists: false };
  const raw = fs.readFileSync(configPath, "utf-8");
  if (!raw.trim()) return { config: normalizeGlobalConfig(DEFAULT_GLOBAL_CONFIG), configPath, exists: true };
  try {
    const parsed = JSON.parse(raw);
    return { config: normalizeGlobalConfig(parsed), configPath, exists: true };
  } catch (err) {
    const detail = err instanceof SyntaxError ? formatJsonError(raw, err) : String(err);
    console.log(`  [warn] invalid global config ${configPath}: ${detail}`);
    return { config: normalizeGlobalConfig(DEFAULT_GLOBAL_CONFIG), configPath, exists: true };
  }
}

// ── Config ─────────────────────────────────────────────────

function normalizeSession(v, maxHistory = MAX_HISTORY) {
  const s = v && typeof v === "object" && !Array.isArray(v) ? v : {};
  return {
    sessionId: typeof s.sessionId === "string" ? s.sessionId : "",
    turn: Number.isInteger(s.turn) && s.turn >= 0 ? s.turn : 0,
    summary: typeof s.summary === "string" ? s.summary : "",
    history: (Array.isArray(s.history) ? s.history : [])
      .filter((h) => h && typeof h === "object")
      .map((h) => ({
        at: typeof h.at === "string" ? h.at : nowIso(),
        result: typeof h.result === "string" ? h.result : "",
        cost: typeof h.cost === "number" ? h.cost : 0,
        turns: typeof h.turns === "number" ? h.turns : 0,
        input: typeof h.input === "string" ? h.input : "",
      }))
      .slice(-maxHistory),
  };
}

function normalizeConfig(v, maxHistory = MAX_HISTORY) {
  const val = v && typeof v === "object" && !Array.isArray(v) ? v : {};
  return {
    ...val,
    lock: val.lock === true,
    prompt: typeof val.prompt === "string" ? val.prompt : "",
    todos: normalizeList(val.todos),
    doing: normalizeList(val.doing),
    done: normalizeList(val.done),
    session: normalizeSession(val.session, maxHistory),
  };
}

function loadConfig(configPath, maxHistory = MAX_HISTORY) {
  const raw = fs.readFileSync(configPath, "utf-8").trim();
  if (!raw) return normalizeConfig({}, maxHistory);
  const parsed = JSON.parse(raw);
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
  return normalizeConfig(parsed, maxHistory);
}

function resolveProjectConfigPath(dir) {
  for (const name of ROUNDSMAN_FILES) {
    const p = path.join(dir, name);
    if (fs.existsSync(p) && fs.statSync(p).isFile()) return p;
  }
  return "";
}

function saveConfig(configPath, config) {
  const tmp = `${configPath}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, `${JSON.stringify(config, null, 2)}\n`, "utf-8");
  fs.renameSync(tmp, configPath);
}

// ── Discovery & Setup ──────────────────────────────────────

function findGremlinDirs(root, maxDepth = MAX_DEPTH, ignoreDirs = new Set(DEFAULT_GLOBAL_CONFIG.ignoreDirs)) {
  const results = [];
  function walk(dir, depth) {
    if (depth > maxDepth) return;
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    if (entries.some((e) => e.isFile() && ROUNDSMAN_FILES.includes(e.name))) results.push(dir);
    for (const e of entries) {
      if (!e.isDirectory() || e.name.startsWith(".") || ignoreDirs.has(e.name)) continue;
      walk(path.join(dir, e.name), depth + 1);
    }
  }
  walk(root, 0);
  return results;
}

function gitCheckpoint(dir, msg) {
  const root = git(["rev-parse", "--show-toplevel"], dir);
  if (!root.ok || !root.stdout.trim()) return;
  const repoRoot = root.stdout.trim();
  const rel = path.relative(repoRoot, dir) || ".";
  const statusArgs = rel === "."
    ? ["status", "--porcelain"]
    : ["status", "--porcelain", "--", rel];
  const status = git(statusArgs, dir);
  if (!status.ok || !status.stdout.trim()) return;
  const addArgs = rel === "."
    ? ["add", "-A"]
    : ["add", "-A", "--", rel];
  const add = git(addArgs, dir);
  if (!add.ok) return;
  const commitArgs = rel === "."
    ? ["commit", "-m", msg || `roundsman checkpoint ${nowIso()}`]
    : ["commit", "-m", msg || `roundsman checkpoint ${nowIso()}`, "--", rel];
  git(commitArgs, dir);
}

function isGitWorktree(dir) {
  const r = git(["rev-parse", "--is-inside-work-tree"], dir);
  return r.ok && r.stdout.trim() === "true";
}

function setupProject(dir, globalConfig) {
  const configPath = resolveProjectConfigPath(dir);
  if (!configPath) return null;
  let config;
  try {
    config = loadConfig(configPath, globalConfig.maxHistory);
  } catch (err) {
    let detail = err && typeof err.message === "string" ? err.message : String(err);
    if (err instanceof SyntaxError) {
      try {
        const raw = fs.readFileSync(configPath, "utf-8");
        detail = formatJsonError(raw, err);
      } catch {}
    }
    console.log(`  [error] invalid ${configPath}: ${detail}`);
    return null;
  }
  if (!config) return null;
  if (config.lock) { console.log(`  [skip] ${dir} (locked)`); return null; }

  let gitEnabled = isGitWorktree(dir);
  if (!gitEnabled && globalConfig.checkpoint.autoInitGit) {
    const init = git(["init"], dir);
    if (init.ok) {
      gitEnabled = isGitWorktree(dir);
      if (gitEnabled) console.log(`  [git init] ${dir}`);
    }
  }

  if (globalConfig.checkpoint.enabled && !gitEnabled) {
    console.log(`  [warn] git checkpoints disabled for ${dir} (not in a git worktree)`);
  }

  if (globalConfig.checkpoint.enabled && gitEnabled) {
    gitCheckpoint(dir, `roundsman backup ${nowIso()}`);
  }

  // ensure sessionId
  if (!config.session.sessionId) {
    config.session.sessionId = randomUUID();
  }

  saveConfig(configPath, config);
  return {
    dir,
    name: path.basename(dir),
    configPath,
    config,
    state: "idle",
    proc: null,
    globalConfig,
    gitEnabled,
    stopReason: "",
    loop: null,
    snoozeUntil: 0,
  };
}

// ── Prompt Building ────────────────────────────────────────

function buildPrompt(config, userInput) {
  const parts = [];
  parts.push("You are an agent managed by roundsman, a multi-project orchestrator.");
  parts.push("");

  if (config.prompt) {
    parts.push(`Project context: ${config.prompt}`);
    parts.push("");
  }

  parts.push(`Todos: ${config.todos.length ? config.todos.join(" | ") : "(none)"}`);
  parts.push(`Doing: ${config.doing.length ? config.doing.join(" | ") : "(none)"}`);
  parts.push(`Done: ${config.done.length ? config.done.join(" | ") : "(none)"}`);

  if (config.session.summary) {
    parts.push("");
    parts.push(`Session so far: ${config.session.summary}`);
  }

  const meta = Object.entries(config).filter(([k]) => !KNOWN_KEYS.has(k));
  if (meta.length) {
    parts.push("");
    parts.push("Metadata:");
    for (const [k, v] of meta) parts.push(`  ${k}: ${stringifyMeta(v)}`);
  }

  if (userInput) {
    parts.push("");
    parts.push(`User instruction: ${userInput}`);
  }

  parts.push("");
  parts.push("Work on the task. When done, provide a concise summary of what you did.");
  parts.push("Update the project marker file todos/doing/done arrays if the task state changed.");

  return parts.join("\n");
}

// ── Session Management ─────────────────────────────────────

function resetSession(project) {
  const { config, configPath, dir } = project;
  if (project.globalConfig.checkpoint.enabled && project.globalConfig.checkpoint.preTurn && project.gitEnabled) {
    gitCheckpoint(dir, `roundsman pre-reset ${nowIso()}`);
  }
  config.session = {
    sessionId: randomUUID(),
    turn: 0,
    summary: "",
    history: [],
  };
  saveConfig(configPath, config);
}

function revertLastTurn(project) {
  const { dir, config, configPath } = project;
  const last = git(["log", "--oneline", "-1"], dir);
  if (!last.ok || !last.stdout.trim()) return "no commits to revert";

  const msg = last.stdout.trim();
  if (!msg.includes("roundsman turn") && !msg.includes("roundsman pre-turn")) {
    return `last commit is not a roundsman turn: ${msg}`;
  }

  const revert = git(["revert", "HEAD", "--no-edit"], dir);
  if (!revert.ok) return `revert failed: ${revert.stderr.trim().slice(0, 200)}`;

  // pop last history entry
  if (config.session.history.length) {
    config.session.history.pop();
    config.session.turn = Math.max(0, config.session.turn - 1);
    const prev = config.session.history[config.session.history.length - 1];
    config.session.summary = prev ? prev.result.slice(0, 500) : "";
  }

  // reload config from reverted state for todos/doing/done
  try {
    const fresh = loadConfig(configPath, project.globalConfig.maxHistory);
    if (fresh) {
      config.todos = fresh.todos;
      config.doing = fresh.doing;
      config.done = fresh.done;
    }
  } catch (err) {
    console.log(`  [warn] failed to reload ${configPath}: ${err && err.message ? err.message : String(err)}`);
  }

  saveConfig(configPath, config);
  return null;
}

// ── Display ────────────────────────────────────────────────

function displayProject(project) {
  const { config, name, dir } = project;
  console.log(`\n${"─".repeat(60)}`);
  console.log(`  ${name}  (${dir})`);
  console.log(`${"─".repeat(60)}`);

  if (config.prompt) console.log(`  context: ${config.prompt}`);

  if (config.todos.length) console.log(`  todos:   ${config.todos.join(" | ")}`);
  if (config.doing.length) console.log(`  doing:   ${config.doing.join(" | ")}`);
  if (config.done.length) console.log(`  done:    ${config.done.join(" | ")}`);

  if (config.session.summary) console.log(`  summary: ${config.session.summary}`);
  console.log(`  turn:    ${config.session.turn}`);

  const meta = Object.entries(config).filter(([k]) => !KNOWN_KEYS.has(k));
  for (const [k, v] of meta) console.log(`  ${k}: ${stringifyMeta(v)}`);
  console.log();
}

function formatProjectLabel(project) {
  if (!project.globalConfig.ui.showFullPath) return project.name;
  return `${project.name} (${project.dir})`;
}

function displayLastResult(project) {
  const hist = project.config.session.history;
  if (!hist.length) { console.log("  (no turns yet)"); return; }
  const last = hist[hist.length - 1];
  console.log(`\n  Project: ${formatProjectLabel(project)}`);
  console.log(`  Turn ${project.config.session.turn} (${last.at})`);
  console.log(`  Input: ${last.input || "(none)"}`);
  console.log(`  Cost: $${last.cost.toFixed(4)} | Agent turns: ${last.turns}`);
  console.log(`${"─".repeat(60)}`);
  console.log(last.result || "(empty result)");
  console.log(`${"─".repeat(60)}\n`);
}

function displayLog(project) {
  const hist = project.config.session.history;
  if (!hist.length) { console.log("  (no turns yet)"); return; }
  console.log(`\n  Project: ${formatProjectLabel(project)}`);
  for (let i = 0; i < hist.length; i++) {
    const h = hist[i];
    const preview = (h.result || "").slice(0, 80).replace(/\n/g, " ");
    console.log(`  ${i + 1}. ${h.at}  $${h.cost.toFixed(4)}  ${h.turns}t`);
    console.log(`     in:  ${h.input || "(none)"}`);
    console.log(`     out: ${preview}`);
  }
  console.log();
}

function displayStatus(projects) {
  console.log(`\n${"═".repeat(60)}`);
  console.log("  STATUS");
  console.log(`${"═".repeat(60)}`);
  for (const p of projects) {
    const icon = p.state === "working" ? "⚙" : p.state === "idle" ? "·" : p.state === "snoozed" ? "~" : "✗";
    const loop = p.loop ? ` loop ${p.loop.done}/${p.loop.max}` : "";
    const snooze = p.state === "snoozed" ? ` ${formatMsShort(p.snoozeUntil - Date.now())}` : "";
    console.log(`  ${icon} ${p.name.padEnd(30)} ${p.state}${snooze}${loop}`);
  }
  console.log();
}

// ── Background Agent ───────────────────────────────────────

function spawnAgent(project, userInput, onDone, modelOverride) {
  const { dir, config, configPath } = project;
  const cfg = project.globalConfig;

  if (cfg.checkpoint.enabled && cfg.checkpoint.preTurn && project.gitEnabled) {
    gitCheckpoint(dir, `roundsman pre-turn ${config.session.turn + 1}`);
  }

  const prompt = buildPrompt(config, userInput);
  const isResume = config.session.turn > 0;
  const args = ["-p", "--output-format", "json", "--permission-mode", cfg.defaultPermissionMode];
  const model = modelOverride || cfg.defaultModel;
  if (model) args.push("--model", model);

  if (isResume) {
    args.push("--resume", config.session.sessionId);
  } else {
    args.push("--session-id", config.session.sessionId);
  }

  args.push(prompt);

  const env = { ...process.env };
  delete env.CLAUDECODE;
  if (cfg.apiKeyEnvVar && process.env[cfg.apiKeyEnvVar]) {
    env.ANTHROPIC_API_KEY = process.env[cfg.apiKeyEnvVar];
  }

  const proc = spawn(cfg.claudeBin, args, { cwd: dir, env, stdio: "pipe" });
  let stdout = "";
  let stderr = "";

  proc.stdout.on("data", (b) => { stdout += String(b); });
  proc.stderr.on("data", (b) => { stderr += String(b); });

  proc.on("close", (code, signal) => {
    if (project.stopReason) {
      const why = project.stopReason;
      project.stopReason = "";
      onDone(project, `stopped: ${why}${signal ? ` (${signal})` : ""}`, 0, { stopped: true });
      return;
    }

    const at = nowIso();
    config.session.turn += 1;

    let result = "";
    let cost = 0;
    let turns = 0;

    if (code === 0 && stdout.trim()) {
      try {
        const json = JSON.parse(stdout.trim());
        result = json.result || "";
        cost = json.total_cost_usd || 0;
        turns = json.num_turns || 0;

        // update session_id if CLI assigned a different one
        if (json.session_id) config.session.sessionId = json.session_id;
      } catch {
        result = stdout.trim().slice(0, 2000);
      }
    } else {
      result = `error: exit ${code} — ${stderr.trim().slice(0, 500)}`;
    }

    // update summary from result
    if (result && !result.startsWith("error:")) {
      config.session.summary = result.slice(0, 500);
    }

    config.session.history.push({ at, result: result.slice(0, 2000), cost, turns, input: userInput });
    config.session.history = config.session.history.slice(-cfg.maxHistory);

    // reload config in case agent modified it
    try {
      const fresh = loadConfig(configPath, cfg.maxHistory);
      if (fresh) {
        config.todos = fresh.todos;
        config.doing = fresh.doing;
        config.done = fresh.done;
        config.prompt = fresh.prompt;
      }
    } catch (err) {
      console.log(`  [warn] failed to reload ${configPath}: ${err && err.message ? err.message : String(err)}`);
    }

    saveConfig(configPath, config);

    if (cfg.checkpoint.enabled && cfg.checkpoint.postTurn && project.gitEnabled) {
      gitCheckpoint(dir, `roundsman turn ${config.session.turn}: ${result.slice(0, 60)}`);
    }

    onDone(project, result, cost, { stopped: false });
  });

  proc.on("error", (err) => {
    onDone(project, `spawn error: ${err.message}`, 0);
  });

  project.proc = proc;
  project.state = "working";
}

// ── Readline Helpers ───────────────────────────────────────

function createRl() {
  return createInterface({ input: process.stdin, output: process.stdout });
}

function ask(rl, prompt) {
  return new Promise((resolve) => rl.question(prompt, resolve));
}

function parseAction(input) {
  const raw = input.trim();
  if (!raw) return "work";
  return raw.startsWith("/") ? raw.slice(1) : raw;
}

function parseLoopCommand(action) {
  const m = action.match(/^loop\s+(\d+)\s+(.+)$/i);
  if (!m) return null;
  const max = Number(m[1]);
  const goal = m[2].trim();
  if (!Number.isSafeInteger(max) || max < 1 || !goal) return null;
  return { max, goal };
}

function parseCommand(action) {
  const s = action.trim();
  const i = s.indexOf(" ");
  if (i < 0) return { cmd: s.toLowerCase(), arg: "" };
  return { cmd: s.slice(0, i).toLowerCase(), arg: s.slice(i + 1).trim() };
}

function parseDurationMs(input) {
  const s = input.trim().toLowerCase();
  const m = s.match(/^(\d+)\s*([smhd]?)$/);
  if (!m) return 0;
  const n = Number(m[1]);
  if (!Number.isSafeInteger(n) || n <= 0) return 0;
  const unit = m[2] || "m";
  if (unit === "s") return n * 1000;
  if (unit === "m") return n * 60 * 1000;
  if (unit === "h") return n * 60 * 60 * 1000;
  if (unit === "d") return n * 24 * 60 * 60 * 1000;
  return 0;
}

function formatMsShort(ms) {
  const s = Math.max(1, Math.ceil(ms / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.ceil(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.ceil(m / 60);
  if (h < 24) return `${h}h`;
  return `${Math.ceil(h / 24)}d`;
}

function refreshSnoozed(projects, queue) {
  const now = Date.now();
  const woke = [];
  for (const p of projects) {
    if (p.state !== "snoozed") continue;
    if (!p.snoozeUntil || p.snoozeUntil > now) continue;
    p.state = "idle";
    p.snoozeUntil = 0;
    if (!queue.includes(p)) queue.push(p);
    woke.push(p);
  }
  return woke;
}

function getNextSnoozeMs(projects) {
  const now = Date.now();
  let out = null;
  for (const p of projects) {
    if (p.state !== "snoozed" || !p.snoozeUntil) continue;
    const ms = Math.max(0, p.snoozeUntil - now);
    if (out === null || ms < out) out = ms;
  }
  return out;
}

function getProjectUsage(project) {
  let cost = 0;
  for (const h of project.config.session.history) cost += h.cost;
  return cost;
}

function displayUsage(projects, totalCost) {
  console.log(`\n${"═".repeat(60)}`);
  console.log("  USAGE");
  console.log(`${"═".repeat(60)}`);
  console.log(`  total: $${totalCost.toFixed(4)}`);
  for (const p of projects) {
    const cost = getProjectUsage(p);
    const turns = p.config.session.history.length;
    console.log(`  ${p.name.padEnd(30)} $${cost.toFixed(4)}  ${turns} turns`);
  }
  console.log();
}

function displayStartupConfig(globalConfig, roots, projects) {
  const active = projects.filter((p) => p.gitEnabled).length;
  const total = projects.length;
  console.log(`\n${"═".repeat(60)}`);
  console.log("  CONFIG");
  console.log(`${"═".repeat(60)}`);
  console.log(`  roots: ${roots.join(" | ")}`);
  console.log(`  maxDepth: ${globalConfig.maxDepth} | maxHistory: ${globalConfig.maxHistory}`);
  console.log(`  model: ${globalConfig.defaultModel || "(cli default)"}`);
  console.log(`  permission: ${globalConfig.defaultPermissionMode}`);
  console.log(`  checkpoints: ${globalConfig.checkpoint.enabled ? "on" : "off"} (git: ${active}/${total} projects)`);
  console.log(`  autoInitGit: ${globalConfig.checkpoint.autoInitGit ? "on" : "off"}`);
  console.log("  round-robin:");
  for (const p of projects) console.log(`    - ${p.name} (${p.dir})`);
  console.log();
}

function displayLoops(projects) {
  const active = projects.filter((p) => p.loop);
  if (!active.length) {
    console.log("  (no active loops)");
    return;
  }
  console.log();
  for (const p of active) {
    console.log(`  ${p.name}: ${p.loop.done}/${p.loop.max} "${p.loop.goal}"`);
  }
  console.log();
}

function findProjectBySelector(projects, selector) {
  const q = selector.trim().toLowerCase();
  if (!q) return { kind: "none", matches: [] };
  const exact = projects.filter((p) => p.name.toLowerCase() === q);
  if (exact.length === 1) return { kind: "one", matches: exact };
  const partial = projects.filter((p) => p.name.toLowerCase().includes(q) || p.dir.toLowerCase().includes(q));
  if (partial.length === 1) return { kind: "one", matches: partial };
  if (exact.length > 1) return { kind: "many", matches: exact };
  if (partial.length > 1) return { kind: "many", matches: partial };
  return { kind: "none", matches: [] };
}

function stopLoop(project, queue, why) {
  if (!project.loop) return false;
  project.loop = null;
  if (project.proc) {
    project.stopReason = why || "loop stop";
    project.proc.kill();
    project.proc = null;
    project.state = "idle";
  }
  if (!queue.includes(project)) queue.push(project);
  return true;
}

function killProject(project, queue, why) {
  if (!project.proc) return false;
  project.loop = null;
  project.stopReason = why || "killed";
  project.proc.kill();
  project.proc = null;
  project.state = "idle";
  project.snoozeUntil = 0;
  if (!queue.includes(project)) queue.push(project);
  return true;
}

function dropProject(project, queue) {
  stopLoop(project, queue, "dropped");
  project.state = "dropped";
  project.snoozeUntil = 0;
  const i = queue.indexOf(project);
  if (i >= 0) queue.splice(i, 1);
}

function snoozeProject(project, queue, ms) {
  stopLoop(project, queue, "snoozed");
  project.state = "snoozed";
  project.snoozeUntil = Date.now() + ms;
  const i = queue.indexOf(project);
  if (i >= 0) queue.splice(i, 1);
}

async function runCommand(ctx) {
  const {
    cmd,
    arg,
    actionRaw,
    project,
    projects,
    queue,
    rl,
    totalCost,
    runtime,
    onAgentDone,
  } = ctx;

  if (cmd === "q" || cmd === "quit") return "quit";
  if (cmd === "status") { displayStatus(projects); return "handled"; }
  if (cmd === "loops") { displayLoops(projects); return "handled"; }
  if (cmd === "usage" || cmd === "cost") { displayUsage(projects, totalCost); return "handled"; }

  if (cmd === "model") {
    const next = arg.trim();
    if (!next) console.log(`  → model: ${runtime.model || "(default cli model)"}`);
    else if (next.toLowerCase() === "none") {
      runtime.model = "";
      console.log("  → cleared runtime model override");
    } else {
      runtime.model = next;
      console.log(`  → runtime model set to ${runtime.model}`);
    }
    return "handled";
  }

  if (cmd === "stop") {
    const sel = arg.trim();
    if (!sel || sel === "current" || sel === "this") {
      if (!stopLoop(project, queue, "requested")) console.log(`  → no active loop for ${project.name}`);
      return "handled";
    }
    if (sel === "all") {
      const c = projects.filter((p) => stopLoop(p, queue, "requested")).length;
      if (!c) console.log("  → no active loops to stop");
      return "handled";
    }
    const found = findProjectBySelector(projects, sel);
    if (found.kind === "none") { console.log(`  → no project matched "${sel}"`); return "handled"; }
    if (found.kind === "many") {
      console.log(`  → ambiguous project "${sel}": ${found.matches.map((p) => p.name).join(", ")}`);
      return "handled";
    }
    if (!stopLoop(found.matches[0], queue, "requested")) console.log(`  → no active loop for ${found.matches[0].name}`);
    return "handled";
  }

  if (cmd === "kill") {
    const sel = arg.trim();
    if (!sel || sel === "current" || sel === "this") {
      if (!killProject(project, queue, "requested")) console.log(`  → no running agent for ${project.name}`);
      return "handled";
    }
    if (sel === "all") {
      const c = projects.filter((p) => killProject(p, queue, "requested")).length;
      if (!c) console.log("  → no running agents to kill");
      return "handled";
    }
    const found = findProjectBySelector(projects, sel);
    if (found.kind === "none") { console.log(`  → no project matched "${sel}"`); return "handled"; }
    if (found.kind === "many") {
      console.log(`  → ambiguous project "${sel}": ${found.matches.map((p) => p.name).join(", ")}`);
      return "handled";
    }
    if (!killProject(found.matches[0], queue, "requested")) console.log(`  → no running agent for ${found.matches[0].name}`);
    return "handled";
  }

  if (cmd === "s" || cmd === "skip" || cmd === "drop") {
    dropProject(project, queue);
    console.log(`  → dropped ${project.name}`);
    return "handled";
  }

  if (cmd === "snooze") {
    const ms = parseDurationMs(arg);
    if (!ms) {
      console.log("  → usage: /snooze <n>[s|m|h|d]  (default unit: minutes)");
      return "handled";
    }
    snoozeProject(project, queue, ms);
    console.log(`  → snoozed ${project.name} for ${formatMsShort(ms)}`);
    return "handled";
  }

  if (cmd === "f" || cmd === "fresh" || cmd === "clear") {
    stopLoop(project, queue, "session reset");
    resetSession(project);
    console.log(`  → reset session for ${project.name} (new sessionId, history cleared)`);
    return "handled";
  }

  if (cmd === "v" || cmd === "view") { displayLastResult(project); return "handled"; }
  if (cmd === "l" || cmd === "log") { displayLog(project); return "handled"; }

  if (cmd === "r" || cmd === "revert") {
    const err = revertLastTurn(project);
    if (err) console.log(`  → revert failed: ${err}`);
    else console.log(`  → reverted last turn for ${project.name}`);
    return "handled";
  }

  const loop = parseLoopCommand(actionRaw);
  if (loop) {
    project.loop = { max: loop.max, goal: loop.goal, done: 0 };
    console.log(`  → starting loop ${project.name}: 1/${loop.max} "${loop.goal}"`);
    spawnAgent(project, loop.goal, onAgentDone, runtime.model);
    const i = queue.indexOf(project);
    if (i >= 0) queue.splice(i, 1);
    return "handled";
  }

  if (cmd === "w" || cmd === "work") {
    const input = (await ask(rl, "  what to work on > ")).trim();
    if (!input) { console.log("  → no input, skipping"); return "handled"; }
    console.log(`  → starting agent for ${project.name}...`);
    spawnAgent(project, input, onAgentDone, runtime.model);
    const i = queue.indexOf(project);
    if (i >= 0) queue.splice(i, 1);
    return "handled";
  }

  return "unknown";
}

function showHelp() {
  const globalPath = resolveGlobalConfigPath();
  const lines = [
    "roundsman 🔁",
    "",
    "Usage:",
    "  roundsman [path]",
    "  roundsman --help",
    "  roundsman -h",
    "",
    `Scans path (default: your home directory) for directories containing one of: ${ROUNDSMAN_FILES.join(", ")}.`,
    `Global config path: ${globalPath}`,
    "",
    "REPL commands:",
    "  /work       start an agent turn for the current project",
    "  /drop       remove current project for this run",
    "  /snooze N   pause project; default unit is minutes (s/m/h/d)",
    "  /fresh      reset current project's session",
    "  /view       show last turn output",
    "  /log        show turn history",
    "  /loop N X   run instruction X for up to N iterations",
    "  /stop [id]  stop active loop for current project, project id, or all",
    "  /kill [id]  kill running agent for current project, project id, or all",
    "  /loops      list active loops",
    "  /usage      show total and per-project session cost",
    "  /model [m]  show/set runtime model (use 'none' to clear)",
    "  /clear      alias for /fresh",
    "  /revert     revert last roundsman turn commit",
    "  /status     show project states",
    "  /quit       stop agents and exit",
    "",
    "Aliases: s=>drop, w/f/v/l/r/q and bare status still work.",
  ];
  console.log(lines.join("\n"));
}

// ── Main Loop ──────────────────────────────────────────────

async function main() {
  const args = process.argv.slice(2);
  if (args.includes("--help") || args.includes("-h")) {
    showHelp();
    process.exit(0);
  }

  const global = loadGlobalConfig();
  const globalConfig = global.config;

  const rootArg = args[0];
  const roots = rootArg
    ? [path.resolve(rootArg)]
    : (globalConfig.scanRoots.length ? globalConfig.scanRoots : [os.homedir()]);
  const ignore = new Set(globalConfig.ignoreDirs);

  const dirSet = new Set();
  for (const root of roots) {
    console.log(`Scanning ${root} for ${ROUNDSMAN_FILES.join(" | ")}...\n`);
    const found = findGremlinDirs(root, globalConfig.maxDepth, ignore);
    for (const dir of found) dirSet.add(dir);
  }
  const dirs = Array.from(dirSet);
  if (!dirs.length) { console.log("No projects found."); process.exit(0); }

  console.log(`Found ${dirs.length} project(s):\n`);
  const projects = [];
  for (const dir of dirs) {
    console.log(`  → ${dir}`);
    const p = setupProject(dir, globalConfig);
    if (p) projects.push(p);
  }
  if (!projects.length) { console.log("\nAll projects locked or invalid."); process.exit(0); }

  // REPL
  const rl = createRl();
  displayStartupConfig(globalConfig, roots, projects);
  const ready = (await ask(rl, "  Press enter to start round-robin (or type q to quit) > ")).trim().toLowerCase();
  if (ready === "q" || ready === "quit") {
    rl.close();
    process.exit(0);
  }

  let queue = [...projects]; // round-robin order
  let idx = 0;
  let totalCost = 0;
  let wakeIdle = null;
  const runtime = { model: globalConfig.defaultModel };

  function onAgentDone(project, result, cost, opts = { stopped: false }) {
    totalCost += cost;
    project.state = "idle";
    project.proc = null;

    if (opts.stopped) {
      console.log(`\n  [stopped] ${formatProjectLabel(project)}`);
      console.log(`         [${project.name}] ${result}`);
    } else {
      console.log(`\n  [done] ${formatProjectLabel(project)} ($${cost.toFixed(4)})`);
      const preview = result.slice(0, globalConfig.ui.previewChars).replace(/\n/g, " ");
      console.log(`         [${project.name}] ${preview}`);
    }

    if (!opts.stopped && project.loop) {
      project.loop.done += 1;
      if (result.startsWith("error:")) {
        const err = result.slice(0, 120).replace(/\n/g, " ");
        console.log(`  [loop stop] ${project.name} at ${project.loop.done}/${project.loop.max}: ${err}`);
        project.loop = null;
      } else if (project.loop.done < project.loop.max) {
        const n = project.loop.done + 1;
        console.log(`  [loop] ${project.name} ${n}/${project.loop.max}`);
        spawnAgent(project, project.loop.goal, onAgentDone, runtime.model);
        return;
      } else {
        console.log(`  [loop done] ${project.name} ${project.loop.done}/${project.loop.max}`);
        project.loop = null;
      }
    }

    // re-add to queue if not already there
    if (!queue.includes(project)) queue.push(project);
    if (wakeIdle) {
      const wake = wakeIdle;
      wakeIdle = null;
      wake();
    }
  }

  function cleanup() {
    for (const p of projects) {
      if (p.proc) { p.proc.kill(); p.proc = null; }
    }
  }

  process.on("SIGINT", () => { cleanup(); process.exit(0); });
  process.on("SIGTERM", () => { cleanup(); process.exit(0); });

  console.log(`\n${"═".repeat(60)}`);
  console.log("  🔁 ROUNDSMAN REPL");
  console.log("  /work /loop /stop /kill /loops /usage /model /snooze /drop /fresh /view /log /revert /quit /status");
  console.log(`${"═".repeat(60)}\n`);

  while (true) {
    refreshSnoozed(projects, queue);

    // find next idle project
    const idle = queue.filter((p) => p.state === "idle");
    const working = projects.filter((p) => p.state === "working");
    const snoozed = projects.filter((p) => p.state === "snoozed");

    if (!idle.length && !working.length && !snoozed.length) {
      console.log("\nAll projects dropped or done. Exiting.");
      break;
    }

    if (!idle.length) {
      displayStatus(projects);
      console.log("  No active idle projects. Waiting...\n");
      await new Promise((resolve) => {
        let done = false;
        let to = null;
        const finish = () => {
          if (done) return;
          done = true;
          if (wakeIdle === finish) wakeIdle = null;
          if (to) clearTimeout(to);
          resolve();
        };
        wakeIdle = finish;
        const ms = getNextSnoozeMs(projects);
        if (ms !== null) to = setTimeout(finish, ms);
      });
      continue;
    }

    // round-robin through idle projects
    idx = idx % idle.length;
    const project = idle[idx];
    idx = (idx + 1) % Math.max(idle.length, 1);

    displayProject(project);

    const actionRaw = parseAction(await ask(rl, "  command (/work, /loop, /stop, /kill, /quit) > "));
    const { cmd, arg } = parseCommand(actionRaw);
    const r = await runCommand({
      cmd,
      arg,
      actionRaw,
      project,
      projects,
      queue,
      rl,
      totalCost,
      runtime,
      onAgentDone,
    });
    if (r === "quit") {
      cleanup();
      break;
    }
    if (r === "handled") continue;
    console.log("  → unknown command, try /work /loop /stop /kill /loops /usage /model /snooze /drop /fresh /view /log /revert /quit /status");
  }

  rl.close();
  console.log(`\n  Total cost: $${totalCost.toFixed(4)}`);
  console.log(`${"═".repeat(60)}\n`);
}

if (require.main === module) {
  main();
}

module.exports = {
  buildPrompt,
  dropProject,
  killProject,
  normalizeConfig,
  normalizeGlobalConfig,
  normalizeSession,
  parseAction,
  parseDurationMs,
  parseLoopCommand,
  refreshSnoozed,
  snoozeProject,
  stopLoop,
};
