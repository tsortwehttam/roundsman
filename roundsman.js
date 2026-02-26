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
const DEFAULT_PROJECT_CONFIG = {
  prompt: "",
  todos: [],
  doing: [],
  done: [],
  macros: {},
  watch: "",
  hooks: {
    beforeVisit: "",
    afterVisit: "",
    afterWatchSuccess: "",
  },
};
const KNOWN_KEYS = new Set(["prompt", "todos", "doing", "lock", "done", "session", "macros", "watch", "hooks"]);
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
const PROJECT_TAG_WIDTH = 8;
const ANSI = {
  reset: "\x1b[0m",
  dim: "\x1b[2m",
  gray: "\x1b[90m",
  cyan: "\x1b[36m",
  green: "\x1b[32m",
};
const PROJECT_COLORS = ["\x1b[31m", "\x1b[32m", "\x1b[33m", "\x1b[34m", "\x1b[35m", "\x1b[36m", "\x1b[91m", "\x1b[92m", "\x1b[93m", "\x1b[94m", "\x1b[95m", "\x1b[96m"];
const STREAM_PREVIEW_CHARS = 240;
const MAX_ACTIVITY = 400;
const OUTPUT = {
  color: true,
};

// ── Utilities ──────────────────────────────────────────────

function normalizeList(v) {
  if (Array.isArray(v)) return v.map((x) => String(x));
  if (v === undefined || v === null || v === "") return [];
  return [String(v)];
}

function normalizeMacros(v) {
  const raw = v && typeof v === "object" && !Array.isArray(v) ? v : {};
  const out = {};
  for (const [k, val] of Object.entries(raw)) {
    const name = String(k).trim();
    const body = typeof val === "string" ? val.trim() : "";
    if (!name || !body) continue;
    out[name] = body;
  }
  return out;
}

function normalizeHooks(v) {
  const raw = v && typeof v === "object" && !Array.isArray(v) ? v : {};
  return {
    beforeVisit: typeof raw.beforeVisit === "string" ? raw.beforeVisit.trim() : "",
    afterVisit: typeof raw.afterVisit === "string" ? raw.afterVisit.trim() : "",
    afterWatchSuccess: typeof raw.afterWatchSuccess === "string" ? raw.afterWatchSuccess.trim() : "",
  };
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

function setOutputColor(enabled) {
  OUTPUT.color = enabled === true;
}

function style(text, code) {
  if (!OUTPUT.color || !code) return text;
  return `${code}${text}${ANSI.reset}`;
}

function hashText(text) {
  let h = 2166136261;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = (h * 16777619) >>> 0;
  }
  return h >>> 0;
}

function fitTag(text, width = PROJECT_TAG_WIDTH) {
  const s = String(text || "").slice(0, width);
  return s.padEnd(width, " ");
}

function getProjectPrefix(project) {
  const key = project && typeof project === "object" ? (project.dir || project.name || "") : "";
  const tag = fitTag(project && project.name ? project.name : "agent");
  const idx = PROJECT_COLORS.length ? hashText(key) % PROJECT_COLORS.length : 0;
  const color = PROJECT_COLORS[idx] || "";
  return `${style(`[${tag}]`, color)} ${style(">", color)}`;
}

function rmLog(msg = "") {
  if (!msg) {
    process.stdout.write("\n");
    return;
  }
  const prefix = `${style("[R]", `${ANSI.dim}${ANSI.gray}`)} `;
  for (const line of String(msg).split("\n")) process.stdout.write(`${prefix}${line}\n`);
}

function agentLog(project, msg = "") {
  const prefix = `${getProjectPrefix(project)} `;
  for (const line of String(msg).split("\n")) process.stdout.write(`${prefix}${line}\n`);
}

function previewText(v, max = STREAM_PREVIEW_CHARS) {
  const s = String(v || "").replace(/\s+/g, " ").trim();
  if (!s) return "";
  if (s.length <= max) return s;
  return `${s.slice(0, max - 3)}...`;
}

function extractText(v) {
  if (!v) return "";
  if (typeof v === "string") return v;
  if (Array.isArray(v)) return v.map((x) => extractText(x)).filter((x) => x).join(" ");
  if (typeof v !== "object") return String(v);

  if (typeof v.text === "string" && v.text) return v.text;
  if (typeof v.output === "string" && v.output) return v.output;
  if (typeof v.result === "string" && v.result) return v.result;
  if (typeof v.message === "string" && v.message) return v.message;
  if (v.delta) return extractText(v.delta);
  if (v.content) return extractText(v.content);
  return "";
}

function unwrapStreamEvent(evt) {
  if (!evt || typeof evt !== "object") return null;
  if (evt.event && typeof evt.event === "object") return evt.event;
  return evt;
}

function toProgressLine(evt) {
  const e = unwrapStreamEvent(evt);
  if (!e) return "";

  if (e.type === "content_block_start" && e.content_block && e.content_block.type === "tool_use") {
    const name = String(e.content_block.name || "tool");
    const input = previewText(stringifyMeta(e.content_block.input || ""));
    return `[step] ${name}${input ? ` ${input}` : ""}`;
  }

  if (e.type === "tool_use") {
    const name = String(e.name || "tool");
    const input = previewText(stringifyMeta(e.input || ""));
    return `[step] ${name}${input ? ` ${input}` : ""}`;
  }

  if (e.type === "tool_result") {
    const out = previewText(extractText(e));
    if (!out) return "[output]";
    return `[output] ${out}`;
  }

  if (e.type === "assistant" || (e.type === "message" && e.role === "assistant")) {
    const out = previewText(extractText(e));
    if (!out) return "";
    return `[agent] ${out}`;
  }

  if (e.type === "error") {
    const out = previewText(extractText(e) || stringifyMeta(e.error || ""));
    return `[error] ${out || "agent error"}`;
  }

  if (e.type === "system") {
    const out = previewText(extractText(e));
    if (!out) return "";
    return `[system] ${out}`;
  }

  return "";
}

function isInputWaitEvent(evt) {
  const e = unwrapStreamEvent(evt);
  if (!e) return false;
  const t = typeof e.type === "string" ? e.type.toLowerCase() : "";
  if (t.includes("input") && (t.includes("wait") || t.includes("request") || t.includes("required"))) return true;
  const txt = extractText(e).toLowerCase();
  if (!txt) return false;
  return txt.includes("waiting for user input") || txt.includes("awaiting user input") || txt.includes("user input required");
}

function pushBufferedProgress(project, msg) {
  if (!msg) return;
  if (!Array.isArray(project.pendingStream)) project.pendingStream = [];
  project.pendingStream.push(msg);
  if (project.pendingStream.length > 200) project.pendingStream = project.pendingStream.slice(-200);
}

function emitProgress(project, msg) {
  if (!msg) return;
  pushActivity(project, msg);
  if (project.holdStream === true) {
    pushBufferedProgress(project, msg);
    return;
  }
  agentLog(project, msg);
}

function flushBufferedProgress(project) {
  const list = Array.isArray(project.pendingStream) ? project.pendingStream : [];
  if (!list.length) return;
  agentLog(project, `[buffered] ${list.length} message(s) while waiting for user input`);
  for (const msg of list) agentLog(project, msg);
  project.pendingStream = [];
}

function applyStreamEvent(state, evt) {
  const e = unwrapStreamEvent(evt);
  if (!e) return state;
  const next = state;
  if (typeof e.result === "string") next.result = e.result;
  if (typeof e.total_cost_usd === "number") next.cost = e.total_cost_usd;
  if (typeof e.num_turns === "number") next.turns = e.num_turns;
  if (typeof e.session_id === "string" && e.session_id) next.sessionId = e.session_id;
  return next;
}

function hasSuccessfulTurn(config) {
  const hist = config && config.session && Array.isArray(config.session.history) ? config.session.history : [];
  for (const h of hist) {
    const r = h && typeof h.result === "string" ? h.result : "";
    if (r && !r.startsWith("error:")) return true;
  }
  return false;
}

function pushActivity(project, msg) {
  if (!msg) return;
  if (!Array.isArray(project.activity)) project.activity = [];
  project.activity.push({ at: nowIso(), msg: String(msg) });
  if (project.activity.length > MAX_ACTIVITY) {
    project.activity = project.activity.slice(-MAX_ACTIVITY);
  }
}

function consumeStreamChunk(chunk, state, onLine) {
  let buf = state.lineBuf + String(chunk || "");
  let i = buf.indexOf("\n");
  while (i >= 0) {
    const line = buf.slice(0, i).trim();
    if (line) onLine(line);
    buf = buf.slice(i + 1);
    i = buf.indexOf("\n");
  }
  state.lineBuf = buf;
}

function consumeStreamTail(state, onLine) {
  const line = String(state.lineBuf || "").trim();
  if (line) onLine(line);
  state.lineBuf = "";
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
    macros: normalizeMacros(val.macros),
    watch: typeof val.watch === "string" ? val.watch.trim() : "",
    hooks: normalizeHooks(val.hooks),
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

function buildProjectConfig(seed) {
  const raw = seed && typeof seed === "object" && !Array.isArray(seed) ? seed : {};
  const prompt = typeof raw.prompt === "string" ? raw.prompt.trim() : "";
  const todos = normalizeList(raw.todos).map((x) => x.trim()).filter((x) => x);
  const watch = typeof raw.watch === "string" ? raw.watch.trim() : "";
  const hooks = normalizeHooks(raw.hooks);
  return {
    ...DEFAULT_PROJECT_CONFIG,
    prompt,
    todos,
    watch,
    hooks,
  };
}

function createProjectConfig(dir, seed) {
  const target = path.resolve(dir || process.cwd());
  if (!fs.existsSync(target)) fs.mkdirSync(target, { recursive: true });
  if (!fs.statSync(target).isDirectory()) return { ok: false, error: `not a directory: ${target}` };
  const markerPath = resolveProjectConfigPath(target);
  if (markerPath) return { ok: false, error: `project marker already exists: ${markerPath}` };
  const configPath = path.join(target, "roundsman.json");
  saveConfig(configPath, buildProjectConfig(seed));
  return { ok: true, configPath };
}

// ── Discovery & Setup ──────────────────────────────────────

function findGremlinDirs(root, maxDepth = MAX_DEPTH, ignoreDirs = new Set(DEFAULT_GLOBAL_CONFIG.ignoreDirs)) {
  const results = [];

  function isGitWorktreesInternalPath(dir) {
    const parts = path.resolve(dir).split(path.sep).filter((x) => x);
    for (let i = 0; i < parts.length - 1; i++) {
      if (parts[i] === ".git" && parts[i + 1] === "worktrees") return true;
    }
    return false;
  }

  function walk(dir, depth) {
    if (depth > maxDepth) return;
    if (isGitWorktreesInternalPath(dir)) return;
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

function getGitMeta(dir) {
  const root = git(["rev-parse", "--show-toplevel"], dir);
  if (!root.ok || !root.stdout.trim()) return { enabled: false, repoRoot: "", repoName: "", branch: "" };
  const repoRoot = root.stdout.trim();
  const repoName = path.basename(repoRoot);
  const branchResult = git(["branch", "--show-current"], dir);
  const branch = branchResult.ok && branchResult.stdout.trim() ? branchResult.stdout.trim() : "(detached)";
  return { enabled: true, repoRoot, repoName, branch };
}

function formatRepoTag(project) {
  if (!project.repoName || !project.branch) return project.name;
  return `${project.repoName}@${project.branch}`;
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

  let gitMeta = getGitMeta(dir);
  let gitEnabled = gitMeta.enabled;
  if (!gitEnabled && globalConfig.checkpoint.autoInitGit) {
    const init = git(["init"], dir);
    if (init.ok) {
      gitMeta = getGitMeta(dir);
      gitEnabled = gitMeta.enabled;
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
    repoRoot: gitMeta.repoRoot,
    repoName: gitMeta.repoName,
    branch: gitMeta.branch,
    configPath,
    config,
    state: "idle",
    proc: null,
    globalConfig,
    gitEnabled,
    stopReason: "",
    loop: null,
    snoozeUntil: 0,
    holdStream: false,
    pendingStream: [],
    activity: [],
    watchProc: null,
    watchStopReason: "",
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
  const { config, dir } = project;
  const tag = formatRepoTag(project);
  rmLog(`project: ${tag} (${dir})`);
  if (config.prompt) rmLog(`context: ${config.prompt}`);
  if (config.todos.length) rmLog(`todos: ${config.todos.join(" | ")}`);
  if (config.doing.length) rmLog(`doing: ${config.doing.join(" | ")}`);
  if (config.done.length) rmLog(`done: ${config.done.join(" | ")}`);
  if (config.session.summary) rmLog(`summary: ${config.session.summary}`);
  rmLog(`turn: ${config.session.turn}`);

  const meta = Object.entries(config).filter(([k]) => !KNOWN_KEYS.has(k));
  for (const [k, v] of meta) rmLog(`${k}: ${stringifyMeta(v)}`);
}

function formatProjectLabel(project) {
  const tag = formatRepoTag(project);
  if (!project.globalConfig.ui.showFullPath) return tag;
  return `${tag} (${project.dir})`;
}

function displayLastResult(project) {
  const hist = project.config.session.history;
  if (!hist.length) { rmLog("(no turns yet)"); return; }
  const last = hist[hist.length - 1];
  rmLog(`result: ${formatProjectLabel(project)}`);
  rmLog(`turn ${project.config.session.turn} at ${last.at}`);
  rmLog(`input: ${last.input || "(none)"}`);
  rmLog(`cost: $${last.cost.toFixed(4)} | agent turns: ${last.turns}`);
  agentLog(project, last.result || "(empty result)");
}

function displayLog(project) {
  const hist = project.config.session.history;
  if (!hist.length) { rmLog("(no turns yet)"); return; }
  rmLog(`log: ${formatProjectLabel(project)}`);
  for (let i = 0; i < hist.length; i++) {
    const h = hist[i];
    const preview = (h.result || "").slice(0, 80).replace(/\n/g, " ");
    rmLog(`${i + 1}. ${h.at}  $${h.cost.toFixed(4)}  ${h.turns}t`);
    rmLog(`in: ${h.input || "(none)"}`);
    agentLog(project, preview || "(empty result)");
  }
}

function displayStatus(projects, includeDropped = false) {
  rmLog("status:");
  for (const p of projects) {
    if (!includeDropped && p.state === "dropped") continue;
    const icon = p.state === "working" ? "⚙" : p.state === "idle" ? "·" : p.state === "snoozed" ? "~" : p.state === "watching" ? "⌛" : "✗";
    const loop = p.loop ? ` loop ${p.loop.done}/${p.loop.max}` : "";
    const snooze = p.state === "snoozed" ? ` ${formatMsShort(p.snoozeUntil - Date.now())}` : "";
    rmLog(`${icon} ${formatRepoTag(p).padEnd(30)} ${p.state}${snooze}${loop}`);
  }
}

function displayActivity(projects, max = 30) {
  const n = Number.isSafeInteger(max) && max > 0 ? max : 30;
  const rows = [];
  for (const p of projects) {
    const items = Array.isArray(p.activity) ? p.activity : [];
    for (const e of items) {
      if (!e || typeof e !== "object") continue;
      if (typeof e.at !== "string" || typeof e.msg !== "string") continue;
      rows.push({ at: e.at, msg: e.msg, project: p });
    }
  }
  rows.sort((a, b) => a.at.localeCompare(b.at));
  const tail = rows.slice(-n);
  if (!tail.length) {
    rmLog("activity: no agent output yet");
    return;
  }
  rmLog(`activity: last ${tail.length} event(s)`);
  for (const row of tail) {
    const t = row.at.slice(11, 19);
    rmLog(`${t} ${formatRepoTag(row.project)} ${row.msg}`);
  }
}

// ── Background Agent ───────────────────────────────────────

function spawnAgent(project, userInput, onDone, modelOverride) {
  const { dir, config, configPath } = project;
  const cfg = project.globalConfig;

  if (cfg.checkpoint.enabled && cfg.checkpoint.preTurn && project.gitEnabled) {
    gitCheckpoint(dir, `roundsman pre-turn ${config.session.turn + 1}`);
  }

  const prompt = buildPrompt(config, userInput);
  const isResume = hasSuccessfulTurn(config);
  const args = ["-p", "--output-format", "stream-json", "--verbose", "--permission-mode", cfg.defaultPermissionMode];
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

  const proc = spawn(cfg.claudeBin, args, { cwd: dir, env, stdio: ["ignore", "pipe", "pipe"] });
  let stdout = "";
  let stderr = "";
  const stream = { lineBuf: "", result: "", cost: 0, turns: 0, sessionId: "", streamSeen: false };
  const stderrState = { lineBuf: "" };
  project.holdStream = false;
  let waitStop = false;
  function stopForInputWait() {
    if (waitStop) return;
    waitStop = true;
    project.stopReason = "agent requested user input";
    proc.kill();
  }

  proc.stdout.on("data", (b) => {
    const chunk = String(b);
    stdout += chunk;
    consumeStreamChunk(chunk, stream, (line) => {
      let evt = null;
      try {
        evt = JSON.parse(line);
      } catch {
        return;
      }
      stream.streamSeen = true;
      applyStreamEvent(stream, evt);
      if (isInputWaitEvent(evt)) {
        emitProgress(project, "[wait] agent is waiting for user input; streaming paused");
        project.holdStream = true;
        stopForInputWait();
        return;
      }
      const msg = toProgressLine(evt);
      emitProgress(project, msg);
    });
  });

  proc.stderr.on("data", (b) => {
    const chunk = String(b);
    stderr += chunk;
    consumeStreamChunk(chunk, stderrState, (line) => {
      const msg = previewText(line);
      if (!msg) return;
      emitProgress(project, `[stderr] ${msg}`);
      if (line.toLowerCase().includes("waiting for user input")) {
        project.holdStream = true;
        stopForInputWait();
      }
    });
  });

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

    consumeStreamTail(stream, (line) => {
      let evt = null;
      try {
        evt = JSON.parse(line);
      } catch {
        return;
      }
      stream.streamSeen = true;
      applyStreamEvent(stream, evt);
      if (isInputWaitEvent(evt)) {
        emitProgress(project, "[wait] agent is waiting for user input; streaming paused");
        project.holdStream = true;
        stopForInputWait();
        return;
      }
      const msg = toProgressLine(evt);
      emitProgress(project, msg);
    });
    consumeStreamTail(stderrState, (line) => {
      const msg = previewText(line);
      if (!msg) return;
      emitProgress(project, `[stderr] ${msg}`);
    });

    if (code === 0 && stdout.trim()) {
      if (stream.streamSeen) {
        result = stream.result || "";
        cost = stream.cost || 0;
        turns = stream.turns || 0;
        if (stream.sessionId) config.session.sessionId = stream.sessionId;
      }

      if (!result) {
        try {
          const json = JSON.parse(stdout.trim());
          result = json.result || "";
          if (!cost) cost = json.total_cost_usd || 0;
          if (!turns) turns = json.num_turns || 0;
          if (json.session_id) config.session.sessionId = json.session_id;
        } catch {
          result = stdout.trim().slice(0, 2000);
        }
      }
    } else {
      const err = stderr.trim().slice(0, 500);
      const out = stdout.trim().slice(0, 500);
      const detail = err || out;
      result = `error: exit ${code} — ${detail}`;
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

function spawnWatcher(project, onDone) {
  const cmd = typeof project.config.watch === "string" ? project.config.watch.trim() : "";
  if (!cmd) return false;
  if (project.watchProc) return true;

  const proc = spawn(cmd, { cwd: project.dir, shell: true, stdio: ["ignore", "pipe", "pipe"] });
  const out = { lineBuf: "" };
  const err = { lineBuf: "" };
  project.watchStopReason = "";

  proc.stdout.on("data", (b) => {
    consumeStreamChunk(b, out, (line) => {
      const msg = previewText(line);
      if (!msg) return;
      pushActivity(project, `[watch] ${msg}`);
      agentLog(project, `[watch] ${msg}`);
    });
  });

  proc.stderr.on("data", (b) => {
    consumeStreamChunk(b, err, (line) => {
      const msg = previewText(line);
      if (!msg) return;
      pushActivity(project, `[watch stderr] ${msg}`);
      agentLog(project, `[watch stderr] ${msg}`);
    });
  });

  proc.on("close", (code, signal) => {
    consumeStreamTail(out, (line) => {
      const msg = previewText(line);
      if (!msg) return;
      pushActivity(project, `[watch] ${msg}`);
      agentLog(project, `[watch] ${msg}`);
    });
    consumeStreamTail(err, (line) => {
      const msg = previewText(line);
      if (!msg) return;
      pushActivity(project, `[watch stderr] ${msg}`);
      agentLog(project, `[watch stderr] ${msg}`);
    });
    const stop = project.watchStopReason;
    project.watchStopReason = "";
    project.watchProc = null;
    onDone(project, { code, signal, stopped: stop !== "" });
  });

  proc.on("error", () => {
    project.watchProc = null;
    onDone(project, { code: null, signal: null, stopped: false });
  });

  project.watchProc = proc;
  project.state = "watching";
  return true;
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
  if (raw.startsWith("/")) return raw.slice(1);
  return `work ${raw}`;
}

function parseBangInput(input) {
  const raw = input.trim();
  if (!raw.startsWith("!")) return null;
  return raw.slice(1).trim();
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

function runShellPassthrough(project, cmd) {
  rmLog(`-> shell (${project.name}): ${cmd}`);
  const out = spawnSync(cmd, { cwd: project.dir, shell: true, stdio: "inherit" });
  if (out.error) {
    rmLog(`-> shell error: ${out.error.message}`);
    return;
  }
  if (typeof out.status === "number" && out.status !== 0) {
    rmLog(`-> shell exit ${out.status}`);
  }
}

function resolveHookAction(config, hookName) {
  const hooks = config && typeof config === "object" && config.hooks && typeof config.hooks === "object" && !Array.isArray(config.hooks)
    ? config.hooks
    : {};
  const raw = typeof hooks[hookName] === "string" ? hooks[hookName].trim() : "";
  if (!raw) return { type: "none", value: "" };
  if (raw.startsWith("!")) {
    const cmd = raw.slice(1).trim();
    if (!cmd) return { type: "none", value: "" };
    return { type: "shell", value: cmd };
  }
  return { type: "prompt", value: raw };
}

function runProjectHook(project, hookName, runtime, onAgentDone) {
  const action = resolveHookAction(project.config, hookName);
  if (action.type === "none") return { ran: false, startedAgent: false };
  if (action.type === "shell") {
    rmLog(`-> hook ${hookName} (${project.name}) shell: ${action.value}`);
    const out = spawnSync(action.value, { cwd: project.dir, shell: true, encoding: "utf-8", stdio: "pipe" });
    const stdout = typeof out.stdout === "string" ? out.stdout.trim() : "";
    const stderr = typeof out.stderr === "string" ? out.stderr.trim() : "";
    if (stdout) {
      for (const line of stdout.split("\n")) {
        const msg = previewText(line);
        if (!msg) continue;
        pushActivity(project, `[hook ${hookName}] ${msg}`);
        agentLog(project, `[hook ${hookName}] ${msg}`);
      }
    }
    if (stderr) {
      for (const line of stderr.split("\n")) {
        const msg = previewText(line);
        if (!msg) continue;
        pushActivity(project, `[hook ${hookName} stderr] ${msg}`);
        agentLog(project, `[hook ${hookName} stderr] ${msg}`);
      }
    }
    if (out.error) {
      const msg = out.error.message || "shell hook failed";
      rmLog(`-> hook ${hookName} error (${project.name}): ${msg}`);
      pushActivity(project, `[hook ${hookName} error] ${msg}`);
    } else if (typeof out.status === "number" && out.status !== 0) {
      rmLog(`-> hook ${hookName} exit ${out.status} (${project.name})`);
      pushActivity(project, `[hook ${hookName} exit] ${out.status}`);
    }
    return { ran: true, startedAgent: false };
  }

  rmLog(`-> hook ${hookName} (${project.name}) prompt`);
  flushBufferedProgress(project);
  project.holdStream = false;
  spawnAgent(project, action.value, onAgentDone, runtime.model);
  return { ran: true, startedAgent: true };
}

function parseTodoInput(input) {
  if (!input || typeof input !== "string") return [];
  return input
    .split(",")
    .map((x) => x.trim())
    .filter((x) => x);
}

function parseCliArgs(args) {
  const raw = Array.isArray(args) ? args : [];
  let help = false;
  let json = false;
  let dryRun = false;
  let noColor = false;
  const pos = [];

  for (const x of raw) {
    if (x === "--help" || x === "-h") { help = true; continue; }
    if (x === "--json") { json = true; continue; }
    if (x === "--dry-run") { dryRun = true; continue; }
    if (x === "--no-color") { noColor = true; continue; }
    pos.push(x);
  }

  const lead = pos[0] || "";
  if (lead === "add" || lead === "init" || lead === "list") {
    return { command: lead, pathArg: pos[1] || "", help, json, dryRun, noColor };
  }
  return { command: "run", pathArg: lead, help, json, dryRun, noColor };
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
  rmLog(`usage: total $${totalCost.toFixed(4)}`);
  for (const p of projects) {
    const cost = getProjectUsage(p);
    const turns = p.config.session.history.length;
    rmLog(`${p.name.padEnd(30)} $${cost.toFixed(4)}  ${turns} turns`);
  }
}

function displayProjectCompact(project) {
  const { config } = project;
  const tag = formatRepoTag(project);
  const doing = config.doing.length ? ` doing: ${config.doing[0]}` : "";
  const turn = ` t${config.session.turn}`;
  rmLog(`${tag}${turn}${doing}`);
}

function displayStartupConfig(globalConfig, roots, projects) {
  const active = projects.filter((p) => p.gitEnabled).length;
  const total = projects.length;
  rmLog("config:");
  rmLog(`roots: ${roots.join(" | ")}`);
  rmLog(`maxDepth: ${globalConfig.maxDepth} | maxHistory: ${globalConfig.maxHistory}`);
  rmLog(`model: ${globalConfig.defaultModel || "(cli default)"}`);
  rmLog(`permission: ${globalConfig.defaultPermissionMode}`);
  rmLog(`checkpoints: ${globalConfig.checkpoint.enabled ? "on" : "off"} (git: ${active}/${total})`);
  rmLog(`autoInitGit: ${globalConfig.checkpoint.autoInitGit ? "on" : "off"}`);
  rmLog("round-robin:");
  for (const p of projects) rmLog(`- ${formatRepoTag(p)} (${p.dir})`);
}

function displayLoops(projects) {
  const active = projects.filter((p) => p.loop);
  if (!active.length) {
    rmLog("(no active loops)");
    return;
  }
  rmLog("loops:");
  for (const p of active) {
    rmLog(`${formatRepoTag(p)}: ${p.loop.done}/${p.loop.max} "${p.loop.goal}"`);
  }
}

function findProjectBySelector(projects, selector) {
  const q = selector.trim().toLowerCase();
  if (!q) return { kind: "none", matches: [] };
  const exact = projects.filter((p) => p.name.toLowerCase() === q);
  if (exact.length === 1) return { kind: "one", matches: exact };
  const partial = projects.filter((p) => (
    p.name.toLowerCase().includes(q)
    || formatRepoTag(p).toLowerCase().includes(q)
    || p.dir.toLowerCase().includes(q)
  ));
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

function stopWatcher(project, why) {
  if (!project.watchProc) return false;
  project.watchStopReason = why || "stopped";
  project.watchProc.kill();
  project.watchProc = null;
  return true;
}

function killProject(project, queue, why) {
  let killed = false;
  if (project.proc) {
    project.loop = null;
    project.stopReason = why || "killed";
    project.proc.kill();
    project.proc = null;
    killed = true;
  }
  if (stopWatcher(project, why || "killed")) {
    killed = true;
  }
  if (!killed) return false;
  project.state = "idle";
  project.snoozeUntil = 0;
  if (!queue.includes(project)) queue.push(project);
  return true;
}

function dropProject(project, queue) {
  stopLoop(project, queue, "dropped");
  stopWatcher(project, "dropped");
  project.state = "dropped";
  project.snoozeUntil = 0;
  const i = queue.indexOf(project);
  if (i >= 0) queue.splice(i, 1);
}

function snoozeProject(project, queue, ms) {
  stopLoop(project, queue, "snoozed");
  stopWatcher(project, "snoozed");
  project.state = "snoozed";
  project.snoozeUntil = Date.now() + ms;
  const i = queue.indexOf(project);
  if (i >= 0) queue.splice(i, 1);
}

const REPL_ALIASES = {
  q: "quit",
  s: "drop",
  w: "work",
  m: "macro",
  f: "fresh",
  clear: "fresh",
  v: "view",
  l: "log",
  a: "activity",
  r: "revert",
  cost: "usage",
};

function showNoProjectsFound(roots) {
  rmLog("No projects found.");
  if (!roots.length) return;
  const ex = roots[0];
  rmLog("Try:");
  rmLog(`roundsman add ${path.join(ex, "my-project")}`);
  rmLog(`roundsman ${ex}`);
}

function resolveScanRoots(pathArg, globalConfig) {
  if (pathArg) return [path.resolve(pathArg)];
  return globalConfig.scanRoots.length ? globalConfig.scanRoots : [os.homedir()];
}

function scanProjectDirs(roots, globalConfig) {
  const ignore = new Set(globalConfig.ignoreDirs);
  const dirSet = new Set();
  for (const root of roots) {
    const found = findGremlinDirs(root, globalConfig.maxDepth, ignore);
    for (const dir of found) dirSet.add(dir);
  }
  return Array.from(dirSet);
}

function buildScanOutput(roots, dirs) {
  return {
    roots,
    count: dirs.length,
    projects: dirs.map((dir) => ({
      dir,
      marker: resolveProjectConfigPath(dir),
    })),
  };
}

function collectDuplicateRepoBranches(projects) {
  const map = new Map();
  for (const p of projects) {
    if (!p.gitEnabled || !p.repoRoot || !p.branch) continue;
    const key = `${p.repoRoot}::${p.branch}`;
    if (!map.has(key)) map.set(key, []);
    map.get(key).push(p);
  }
  return Array.from(map.values())
    .filter((list) => list.length > 1)
    .map((list) => ({
      repoRoot: list[0].repoRoot,
      repoName: list[0].repoName,
      branch: list[0].branch,
      projects: list,
    }));
}

function displayDuplicateRepoBranchWarnings(projects) {
  const groups = collectDuplicateRepoBranches(projects);
  if (!groups.length) return;
  rmLog("warning: multiple projects share the same repo+branch:");
  for (const g of groups) {
    rmLog(`${g.repoName}@${g.branch}`);
    for (const p of g.projects) rmLog(`- ${p.dir}`);
  }
  rmLog("consider separate branches/worktrees to avoid overlap.");
}

function displayScanOutput(roots, dirs, asJson) {
  const out = buildScanOutput(roots, dirs);
  if (asJson) {
    console.log(`${JSON.stringify(out, null, 2)}`);
    return;
  }
  for (const root of roots) rmLog(`Scanning ${root} for ${ROUNDSMAN_FILES.join(" | ")}...`);
  if (!dirs.length) {
    showNoProjectsFound(roots);
    return;
  }
  rmLog(`Found ${dirs.length} project(s):`);
  for (const row of out.projects) rmLog(`- ${row.dir}`);
}

function displayReplHelp() {
  rmLog("/work /watch /broadcast /macro /skip /loop /stop /kill /loops /usage /model /snooze /drop /fresh /view /log /activity /revert /status /help /quit");
}

function rotateQueue(queue, project) {
  const i = queue.indexOf(project);
  if (i < 0) return;
  queue.splice(i, 1);
  queue.push(project);
}

function skipProjectRounds(queue, project, rounds = 1) {
  const n = Number.isSafeInteger(rounds) && rounds > 0 ? rounds : 1;
  const i = queue.indexOf(project);
  if (i < 0) return 0;
  queue.splice(i, 1);
  const idle = queue.filter((p) => p.state === "idle");
  if (!idle.length) {
    queue.push(project);
    return 0;
  }
  const steps = Math.min(n, idle.length);
  const anchor = idle[steps - 1];
  const j = queue.indexOf(anchor);
  queue.splice(j + 1, 0, project);
  return steps;
}

function collectBroadcastTargets(projects) {
  const list = Array.isArray(projects) ? projects : [];
  return list.filter((p) => p && p.state === "idle");
}

function runScopedProjectCommand(ctx, sel, apply, missingLabel, missingAllLabel) {
  const { project, projects, queue } = ctx;
  if (!sel || sel === "current" || sel === "this") {
    if (!apply(project, queue)) rmLog(`-> ${missingLabel} ${project.name}`);
    return "stay";
  }
  if (sel === "all") {
    const count = projects.filter((p) => apply(p, queue)).length;
    if (!count) rmLog(`-> ${missingAllLabel}`);
    return "stay";
  }
  const found = findProjectBySelector(projects, sel);
  if (found.kind === "none") {
    rmLog(`-> no project matched "${sel}"`);
    return "stay";
  }
  if (found.kind === "many") {
    rmLog(`-> ambiguous project "${sel}": ${found.matches.map((p) => p.name).join(", ")}`);
    return "stay";
  }
  if (!apply(found.matches[0], queue)) rmLog(`-> ${missingLabel} ${found.matches[0].name}`);
  return "stay";
}

const REPL_COMMANDS = {
  quit: async function quit() { return "quit"; },
  status: async function status(ctx) { displayStatus(ctx.projects, true); return "stay"; },
  loops: async function loops(ctx) { displayLoops(ctx.projects); return "stay"; },
  usage: async function usage(ctx) { displayUsage(ctx.projects, ctx.totalCost); return "stay"; },
  activity: async function activity(ctx) {
    const raw = ctx.arg.trim();
    const n = raw ? Number(raw) : 30;
    if (!Number.isSafeInteger(n) || n < 1) {
      rmLog("-> usage: /activity [n>=1]");
      return "stay";
    }
    displayActivity(ctx.projects, n);
    return "stay";
  },
  help: async function help() { displayReplHelp(); return "stay"; },
  model: async function model(ctx) {
    const next = ctx.arg.trim();
    if (!next) rmLog(`-> model: ${ctx.runtime.model || "(default cli model)"}`);
    else if (next.toLowerCase() === "none") {
      ctx.runtime.model = "";
      rmLog("-> cleared runtime model override");
    } else {
      ctx.runtime.model = next;
      rmLog(`-> runtime model set to ${ctx.runtime.model}`);
    }
    return "stay";
  },
  stop: async function stop(ctx) {
    const sel = ctx.arg.trim();
    return runScopedProjectCommand(
      ctx,
      sel,
      (p, queue) => stopLoop(p, queue, "requested"),
      "no active loop for",
      "no active loops to stop",
    );
  },
  kill: async function kill(ctx) {
    const sel = ctx.arg.trim();
    return runScopedProjectCommand(
      ctx,
      sel,
      (p, queue) => killProject(p, queue, "requested"),
      "no running agent for",
      "no running agents to kill",
    );
  },
  drop: async function drop(ctx) {
    dropProject(ctx.project, ctx.queue);
    rmLog(`-> dropped ${ctx.project.name}`);
    return "next";
  },
  macro: async function macro(ctx) {
    const raw = ctx.arg.trim();
    const macros = ctx.project.config.macros;
    const save = () => saveConfig(ctx.project.configPath, ctx.project.config);
    const split = (s) => {
      const i = s.indexOf(" ");
      if (i < 0) return [s, ""];
      return [s.slice(0, i), s.slice(i + 1).trim()];
    };
    const [subRaw, rest] = split(raw);
    const sub = subRaw.toLowerCase();

    if (!raw || sub === "list" || sub === "ls") {
      const names = Object.keys(macros).sort();
      if (!names.length) {
        rmLog("(no macros)");
        return "stay";
      }
      rmLog("macros:");
      for (const name of names) rmLog(`- ${name}`);
      return "stay";
    }

    if (sub === "save" || sub === "set" || sub === "add") {
      const [nameRaw, text] = split(rest);
      const name = nameRaw.trim();
      if (!name || !text) {
        rmLog("-> usage: /macro save <name> <prompt>");
        return "stay";
      }
      macros[name] = text;
      save();
      rmLog(`-> saved macro "${name}"`);
      return "stay";
    }

    if (sub === "rm" || sub === "del" || sub === "delete") {
      const name = rest.trim();
      if (!name) {
        rmLog("-> usage: /macro rm <name>");
        return "stay";
      }
      if (!macros[name]) {
        rmLog(`-> macro not found: "${name}"`);
        return "stay";
      }
      delete macros[name];
      save();
      rmLog(`-> removed macro "${name}"`);
      return "stay";
    }

    if (sub === "show") {
      const name = rest.trim();
      if (!name) {
        rmLog("-> usage: /macro show <name>");
        return "stay";
      }
      const body = macros[name];
      if (!body) {
        rmLog(`-> macro not found: "${name}"`);
        return "stay";
      }
      rmLog(`macro ${name}:`);
      rmLog(body);
      return "stay";
    }

    const runParts = sub === "run" ? split(rest) : [subRaw, rest];
    const name = runParts[0].trim();
    const extra = runParts[1].trim();
    if (!name) {
      rmLog("-> usage: /macro run <name> [extra instruction]");
      return "stay";
    }
    const body = macros[name];
    if (!body) {
      rmLog(`-> macro not found: "${name}"`);
      return "stay";
    }
    const input = extra ? `${body}\n\nAdditional instruction: ${extra}` : body;
    flushBufferedProgress(ctx.project);
    ctx.project.holdStream = false;
    rmLog(`-> starting agent for ${ctx.project.name} with macro "${name}"...`);
    spawnAgent(ctx.project, input, ctx.onAgentDone, ctx.runtime.model);
    const i = ctx.queue.indexOf(ctx.project);
    if (i >= 0) ctx.queue.splice(i, 1);
    return "next";
  },
  skip: async function skip(ctx) {
    const raw = ctx.arg.trim();
    const rounds = raw ? Number(raw) : 1;
    if (!Number.isSafeInteger(rounds) || rounds < 1) {
      rmLog("-> usage: /skip [rounds>=1]");
      return "stay";
    }
    const moved = skipProjectRounds(ctx.queue, ctx.project, rounds);
    if (!moved) {
      rmLog("-> no other idle projects to skip");
      return "stay";
    }
    rmLog(`-> skipped ${ctx.project.name} for ${moved} round${moved === 1 ? "" : "s"}`);
    return "shifted";
  },
  snooze: async function snooze(ctx) {
    const ms = parseDurationMs(ctx.arg);
    if (!ms) {
      rmLog("-> usage: /snooze <n>[s|m|h|d] (default unit: minutes)");
      return "stay";
    }
    snoozeProject(ctx.project, ctx.queue, ms);
    rmLog(`-> snoozed ${ctx.project.name} for ${formatMsShort(ms)}`);
    return "next";
  },
  fresh: async function fresh(ctx) {
    stopLoop(ctx.project, ctx.queue, "session reset");
    resetSession(ctx.project);
    rmLog(`-> reset session for ${ctx.project.name} (new sessionId, history cleared)`);
    return "stay";
  },
  view: async function view(ctx) { displayLastResult(ctx.project); return "stay"; },
  log: async function log(ctx) { displayLog(ctx.project); return "stay"; },
  revert: async function revert(ctx) {
    const err = revertLastTurn(ctx.project);
    if (err) rmLog(`-> revert failed: ${err}`);
    else rmLog(`-> reverted last turn for ${ctx.project.name}`);
    return "stay";
  },
  loop: async function loop(ctx) {
    const loop = parseLoopCommand(ctx.actionRaw);
    if (!loop) {
      rmLog("-> usage: /loop <n> <goal>");
      return "stay";
    }
    ctx.project.loop = { max: loop.max, goal: loop.goal, done: 0 };
    flushBufferedProgress(ctx.project);
    ctx.project.holdStream = false;
    rmLog(`-> starting loop ${ctx.project.name}: 1/${loop.max} "${loop.goal}"`);
    spawnAgent(ctx.project, loop.goal, ctx.onAgentDone, ctx.runtime.model);
    const i = ctx.queue.indexOf(ctx.project);
    if (i >= 0) ctx.queue.splice(i, 1);
    return "next";
  },
  work: async function work(ctx) {
    const input = ctx.arg.trim() || (await ask(ctx.rl, `${ANSI.green}>${ANSI.reset} `)).trim();
    if (!input) {
      rmLog("-> no input, skipping");
      return "stay";
    }
    flushBufferedProgress(ctx.project);
    ctx.project.holdStream = false;
    rmLog(`-> starting agent for ${ctx.project.name}...`);
    spawnAgent(ctx.project, input, ctx.onAgentDone, ctx.runtime.model);
    const i = ctx.queue.indexOf(ctx.project);
    if (i >= 0) ctx.queue.splice(i, 1);
    return "next";
  },
  broadcast: async function broadcast(ctx) {
    const input = ctx.arg.trim() || (await ask(ctx.rl, `${ANSI.green}>${ANSI.reset} `)).trim();
    if (!input) {
      rmLog("-> no input, skipping");
      return "stay";
    }
    const targets = collectBroadcastTargets(ctx.projects);
    if (!targets.length) {
      rmLog("-> no idle projects to broadcast to");
      return "stay";
    }
    rmLog(`-> broadcasting to ${targets.length} project(s)...`);
    for (const p of targets) {
      flushBufferedProgress(p);
      p.holdStream = false;
      rmLog(`-> starting agent for ${p.name}...`);
      spawnAgent(p, input, ctx.onAgentDone, ctx.runtime.model);
      const i = ctx.queue.indexOf(p);
      if (i >= 0) ctx.queue.splice(i, 1);
    }
    return "stay";
  },
  watch: async function watch(ctx) {
    if (ctx.project.watchProc) {
      rmLog(`-> already watching ${ctx.project.name}`);
      return "stay";
    }
    const cmd = typeof ctx.project.config.watch === "string" ? ctx.project.config.watch.trim() : "";
    if (!cmd) {
      rmLog(`-> no watch defined for ${ctx.project.name}`);
      return "stay";
    }
    rmLog(`-> starting watcher for ${ctx.project.name}...`);
    const ok = spawnWatcher(ctx.project, ctx.onWatchDone);
    if (!ok) {
      rmLog(`-> failed to start watcher for ${ctx.project.name}`);
      return "stay";
    }
    const i = ctx.queue.indexOf(ctx.project);
    if (i >= 0) ctx.queue.splice(i, 1);
    return "next";
  },
};

async function runCommand(ctx) {
  const key = REPL_ALIASES[ctx.cmd] || ctx.cmd;
  const run = REPL_COMMANDS[key];
  if (!run) return "unknown";
  return run(ctx);
}

function showHelp() {
  const globalPath = resolveGlobalConfigPath();
  const lines = [
    "roundsman",
    "usage:",
    "roundsman [path]",
    "roundsman add [dir]",
    "roundsman init [dir]",
    "roundsman list [path]",
    "roundsman [path] --dry-run",
    "roundsman [path] --json",
    "roundsman --help | -h",
    `Scans path (default: your home directory) for directories containing one of: ${ROUNDSMAN_FILES.join(", ")}.`,
    `Global config path: ${globalPath}`,
    "commands: add/init/list",
    "flags: --dry-run --json --no-color",
    "repl: /work /watch /broadcast /macro /skip /drop /snooze /fresh /view /log /activity /loop /stop /kill /loops /usage /model /clear /revert /status /help /quit",
    "Aliases: s=>drop, m=>macro, w/f/v/l/a/r/q, cost=>usage, clear=>fresh.",
  ];
  console.log(lines.join("\n"));
}

// ── Main Loop ──────────────────────────────────────────────

async function main() {
  const cli = parseCliArgs(process.argv.slice(2));
  setOutputColor(process.stdout.isTTY && !process.env.NO_COLOR && !cli.noColor);
  if (cli.help) {
    showHelp();
    process.exit(0);
  }

  if (cli.command === "add") {
    const out = createProjectConfig(cli.pathArg || process.cwd());
    if (!out.ok) {
      console.error(`Error: ${out.error}`);
      process.exit(1);
    }
    console.log(`Created ${out.configPath}`);
    process.exit(0);
  }

  if (cli.command === "init") {
    const rl = createRl();
    const prompt = (await ask(rl, "project prompt (optional) > ")).trim();
    const todosRaw = (await ask(rl, "initial todos (comma-separated, optional) > ")).trim();
    rl.close();
    const out = createProjectConfig(cli.pathArg || process.cwd(), { prompt, todos: parseTodoInput(todosRaw) });
    if (!out.ok) {
      console.error(`Error: ${out.error}`);
      process.exit(1);
    }
    console.log(`Created ${out.configPath}`);
    process.exit(0);
  }

  const global = loadGlobalConfig();
  const globalConfig = global.config;
  const roots = resolveScanRoots(cli.pathArg, globalConfig);
  const dirs = scanProjectDirs(roots, globalConfig);
  const scanOnly = cli.command === "list" || cli.dryRun || cli.json;

  if (scanOnly) {
    displayScanOutput(roots, dirs, cli.json);
    if (cli.dryRun && !cli.json) rmLog("Dry run complete.");
    process.exit(0);
  }

  displayScanOutput(roots, dirs, false);
  if (!dirs.length) process.exit(0);

  const projects = [];
  for (const dir of dirs) {
    const p = setupProject(dir, globalConfig);
    if (p) projects.push(p);
  }
  if (!projects.length) { rmLog("All projects locked or invalid."); process.exit(0); }
  displayDuplicateRepoBranchWarnings(projects);

  // REPL
  const rl = createRl();
  displayStartupConfig(globalConfig, roots, projects);
  const ready = (await ask(rl, "press enter to start (or q to quit) > ")).trim().toLowerCase();
  if (ready === "q" || ready === "quit") {
    rl.close();
    process.exit(0);
  }

  let queue = [...projects]; // round-robin order
  let totalCost = 0;
  let wakeIdle = null;
  const runtime = { model: globalConfig.defaultModel };

  function onAgentDone(project, result, cost, opts = { stopped: false }) {
    totalCost += cost;
    project.state = "idle";
    project.proc = null;

    if (opts.stopped) {
      rmLog(`[stopped] ${formatProjectLabel(project)}`);
      agentLog(project, result);
      pushActivity(project, `[stopped] ${result}`);
    } else {
      rmLog(`[done] ${formatProjectLabel(project)} ($${cost.toFixed(4)})`);
      const preview = result.slice(0, globalConfig.ui.previewChars).replace(/\n/g, " ");
      agentLog(project, preview || "(empty result)");
      pushActivity(project, `[done] $${cost.toFixed(4)} ${preview || "(empty result)"}`);
    }

    if (!opts.stopped && project.loop) {
      project.loop.done += 1;
      if (result.startsWith("error:")) {
        const err = result.slice(0, 120).replace(/\n/g, " ");
        rmLog(`[loop stop] ${project.name} at ${project.loop.done}/${project.loop.max}: ${err}`);
        project.loop = null;
      } else if (project.loop.done < project.loop.max) {
        const n = project.loop.done + 1;
        rmLog(`[loop] ${project.name} ${n}/${project.loop.max}`);
        spawnAgent(project, project.loop.goal, onAgentDone, runtime.model);
        return;
      } else {
        rmLog(`[loop done] ${project.name} ${project.loop.done}/${project.loop.max}`);
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
      if (p.watchProc) { p.watchStopReason = "shutdown"; p.watchProc.kill(); p.watchProc = null; }
    }
  }

  function onWatchDone(project, meta) {
    const code = meta && Object.prototype.hasOwnProperty.call(meta, "code") ? meta.code : null;
    const signal = meta && Object.prototype.hasOwnProperty.call(meta, "signal") ? meta.signal : null;
    const stopped = meta && meta.stopped === true;
    project.state = "idle";
    project.watchProc = null;
    if (stopped) {
      const msg = `[watch stopped] ${formatProjectLabel(project)}`;
      rmLog(msg);
      pushActivity(project, msg);
    } else if (code === 0) {
      const msg = `[watch ready] ${formatProjectLabel(project)} exit=0${signal ? ` signal=${signal}` : ""}`;
      rmLog(msg);
      pushActivity(project, msg);
      const hook = runProjectHook(project, "afterWatchSuccess", runtime, onAgentDone);
      if (hook.startedAgent) return;
    } else {
      const msg = `[watch exit] ${formatProjectLabel(project)} exit=${code === null ? "?" : code}${signal ? ` signal=${signal}` : ""}`;
      rmLog(msg);
      pushActivity(project, msg);
    }
    if (!queue.includes(project)) queue.push(project);
    if (wakeIdle) {
      const wake = wakeIdle;
      wakeIdle = null;
      wake();
    }
  }

  process.on("SIGINT", () => { cleanup(); process.exit(0); });
  process.on("SIGTERM", () => { cleanup(); process.exit(0); });

  rmLog("repl:");
  displayReplHelp();

  while (true) {
    refreshSnoozed(projects, queue);

    // find next idle project
    const idle = queue.filter((p) => p.state === "idle");
    const working = projects.filter((p) => p.state === "working");
    const watching = projects.filter((p) => p.state === "watching");
    const snoozed = projects.filter((p) => p.state === "snoozed");

    if (!idle.length && !working.length && !snoozed.length && !watching.length) {
      rmLog("All projects dropped or done. Exiting.");
      break;
    }

    if (!idle.length) {
      displayStatus(projects);
      rmLog("No active idle projects. Waiting...");
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

    // process idle projects in queue order
    const project = idle[0];

    rmLog();
    displayProjectCompact(project);

    const rawInput = (await ask(rl, `${ANSI.green}>${ANSI.reset} `)).trim();
    const bang = parseBangInput(rawInput);
    if (bang !== null) {
      if (!bang) {
        rmLog("-> usage: !<shell command>");
        continue;
      }
      runShellPassthrough(project, bang);
      continue;
    }
    const actionRaw = parseAction(rawInput);
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
      onWatchDone,
    });
    if (r === "quit") {
      cleanup();
      break;
    }
    if (r === "next") {
      rotateQueue(queue, project);
      continue;
    }
    if (r === "shifted") continue;
    if (r === "stay") continue;
    rmLog("-> unknown command, try /help");
  }

  rl.close();
  rmLog(`Total cost: $${totalCost.toFixed(4)}`);
}

if (require.main === module) {
  main();
}

module.exports = {
  applyStreamEvent,
  buildPrompt,
  buildProjectConfig,
  consumeStreamChunk,
  collectDuplicateRepoBranches,
  collectBroadcastTargets,
  createProjectConfig,
  dropProject,
  formatRepoTag,
  hasSuccessfulTurn,
  isInputWaitEvent,
  killProject,
  normalizeConfig,
  normalizeGlobalConfig,
  normalizeHooks,
  normalizeSession,
  parseAction,
  parseBangInput,
  parseCliArgs,
  parseDurationMs,
  parseLoopCommand,
  parseTodoInput,
  refreshSnoozed,
  resolveHookAction,
  rotateQueue,
  skipProjectRounds,
  runShellPassthrough,
  snoozeProject,
  stopLoop,
  toProgressLine,
};
