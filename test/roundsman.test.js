const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const {
  buildPrompt,
  buildProjectConfig,
  collectDuplicateRepoBranches,
  consumeStreamChunk,
  createProjectConfig,
  dropProject,
  formatRepoTag,
  isInputWaitEvent,
  killProject,
  normalizeConfig,
  normalizeGlobalConfig,
  normalizeSession,
  parseAction,
  parseCliArgs,
  parseDurationMs,
  parseLoopCommand,
  parseTodoInput,
  refreshSnoozed,
  snoozeProject,
  stopLoop,
  toProgressLine,
  applyStreamEvent,
} = require("../roundsman.js");

test("normalizeSession defaults and trims history", () => {
  const s = normalizeSession({
    turn: -3,
    history: Array.from({ length: 30 }, (_, i) => ({ result: String(i) })),
  });

  assert.equal(s.turn, 0);
  assert.equal(s.summary, "");
  assert.equal(s.sessionId, "");
  assert.equal(s.history.length, 20);
  assert.equal(s.history[0].result, "10");
  assert.equal(s.history[19].result, "29");
});

test("normalizeConfig coerces list fields and defaults missing arrays", () => {
  const c = normalizeConfig({
    todos: "one",
    doing: null,
    done: ["x", 2],
  });

  assert.deepEqual(c.todos, ["one"]);
  assert.deepEqual(c.doing, []);
  assert.deepEqual(c.done, ["x", "2"]);
});

test("buildPrompt includes metadata and user instruction", () => {
  const c = normalizeConfig({
    prompt: "proj ctx",
    todos: ["a"],
    doing: [],
    done: ["d"],
    team: "infra",
    tags: ["cli", "ops"],
    session: { summary: "previous" },
  });

  const out = buildPrompt(c, "ship it");

  assert.match(out, /Project context: proj ctx/);
  assert.match(out, /Todos: a/);
  assert.match(out, /Done: d/);
  assert.match(out, /Session so far: previous/);
  assert.match(out, /Metadata:\n  team: infra\n  tags: cli, ops/);
  assert.match(out, /User instruction: ship it/);
});

test("buildPrompt does not render known keys as metadata", () => {
  const c = normalizeConfig({
    prompt: "ctx",
    lock: true,
    session: { summary: "s" },
  });

  const out = buildPrompt(c, "go");

  assert.doesNotMatch(out, /\n  prompt:/);
  assert.doesNotMatch(out, /\n  lock:/);
  assert.doesNotMatch(out, /\n  session:/);
});

test("parseAction supports slash syntax and aliases", () => {
  assert.equal(parseAction(""), "work");
  assert.equal(parseAction("/work"), "work");
  assert.equal(parseAction("/STATUS"), "STATUS");
  assert.equal(parseAction("q"), "q");
});

test("parseTodoInput splits comma separated todos", () => {
  assert.deepEqual(parseTodoInput("a, b,  c "), ["a", "b", "c"]);
  assert.deepEqual(parseTodoInput(""), []);
});

test("parseCliArgs parses commands and flags", () => {
  assert.deepEqual(parseCliArgs(["add", "x"]), {
    command: "add",
    pathArg: "x",
    help: false,
    json: false,
    dryRun: false,
    noColor: false,
  });
  assert.deepEqual(parseCliArgs(["list", "--json", "/tmp"]), {
    command: "list",
    pathArg: "/tmp",
    help: false,
    json: true,
    dryRun: false,
    noColor: false,
  });
  assert.deepEqual(parseCliArgs(["--dry-run", "~/Code"]), {
    command: "run",
    pathArg: "~/Code",
    help: false,
    json: false,
    dryRun: true,
    noColor: false,
  });
  assert.deepEqual(parseCliArgs(["list", "--no-color"]), {
    command: "list",
    pathArg: "",
    help: false,
    json: false,
    dryRun: false,
    noColor: true,
  });
});

test("normalizeGlobalConfig keeps model and api key env var", () => {
  const g = normalizeGlobalConfig({
    defaultModel: "claude-sonnet-4-5",
    apiKeyEnvVar: "ROUNDSMAN_ANTHROPIC_API_KEY",
  });
  assert.equal(g.defaultModel, "claude-sonnet-4-5");
  assert.equal(g.apiKeyEnvVar, "ROUNDSMAN_ANTHROPIC_API_KEY");
  assert.equal(g.checkpoint.enabled, false);
  assert.equal(g.checkpoint.autoInitGit, false);
});

test("parseLoopCommand parses max and goal", () => {
  const x = parseLoopCommand("loop 123 continue improving the ui");
  assert.equal(x.max, 123);
  assert.equal(x.goal, "continue improving the ui");
  assert.equal(parseLoopCommand("loop 0 nope"), null);
});

test("parseDurationMs parses common units", () => {
  assert.equal(parseDurationMs("20"), 20 * 60 * 1000);
  assert.equal(parseDurationMs("20m"), 20 * 60 * 1000);
  assert.equal(parseDurationMs("30s"), 30 * 1000);
  assert.equal(parseDurationMs("2h"), 2 * 60 * 60 * 1000);
  assert.equal(parseDurationMs("1d"), 24 * 60 * 60 * 1000);
  assert.equal(parseDurationMs("0m"), 0);
});

test("stopLoop is loop-only", () => {
  let killed = 0;
  const q = [];
  const p = { name: "a", loop: null, proc: { kill() { killed += 1; } }, state: "working", stopReason: "" };
  assert.equal(stopLoop(p, q, "requested"), false);
  assert.equal(killed, 0);
  assert.equal(q.length, 0);
});

test("createProjectConfig writes default roundsman.json", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "roundsman-test-"));
  const out = createProjectConfig(dir);
  assert.equal(out.ok, true);
  assert.equal(out.configPath, path.join(dir, "roundsman.json"));
  const raw = fs.readFileSync(out.configPath, "utf-8");
  assert.deepEqual(JSON.parse(raw), {
    prompt: "",
    todos: [],
    doing: [],
    done: [],
  });
});

test("buildProjectConfig applies prompt and todos", () => {
  const out = buildProjectConfig({ prompt: "  app  ", todos: [" a ", ""] });
  assert.deepEqual(out, {
    prompt: "app",
    todos: ["a"],
    doing: [],
    done: [],
  });
});

test("formatRepoTag prefers repo@branch when available", () => {
  assert.equal(formatRepoTag({ name: "a", repoName: "repo", branch: "feat-x" }), "repo@feat-x");
  assert.equal(formatRepoTag({ name: "a", repoName: "", branch: "" }), "a");
});

test("collectDuplicateRepoBranches groups matching repo+branch", () => {
  const groups = collectDuplicateRepoBranches([
    { gitEnabled: true, repoRoot: "/r/a", repoName: "a", branch: "main", dir: "/r/a/w1" },
    { gitEnabled: true, repoRoot: "/r/a", repoName: "a", branch: "main", dir: "/r/a/w2" },
    { gitEnabled: true, repoRoot: "/r/a", repoName: "a", branch: "feat", dir: "/r/a/w3" },
    { gitEnabled: false, repoRoot: "", repoName: "", branch: "", dir: "/tmp/x" },
  ]);
  assert.equal(groups.length, 1);
  assert.equal(groups[0].repoName, "a");
  assert.equal(groups[0].branch, "main");
  assert.deepEqual(groups[0].projects.map((p) => p.dir), ["/r/a/w1", "/r/a/w2"]);
});

test("toProgressLine renders tool steps and outputs", () => {
  assert.equal(
    toProgressLine({ type: "tool_use", name: "bash", input: { cmd: "ls -la" } }),
    '[step] bash {"cmd":"ls -la"}',
  );
  assert.equal(
    toProgressLine({ type: "tool_result", content: [{ text: "ok" }] }),
    "[output] ok",
  );
});

test("consumeStreamChunk parses newline-delimited chunks", () => {
  const s = { lineBuf: "" };
  const lines = [];
  consumeStreamChunk("{\"a\":1}\n{\"b\":", s, (line) => lines.push(line));
  consumeStreamChunk("2}\n", s, (line) => lines.push(line));
  assert.deepEqual(lines, ['{"a":1}', '{"b":2}']);
});

test("applyStreamEvent updates result and usage fields", () => {
  const s = { result: "", cost: 0, turns: 0, sessionId: "" };
  applyStreamEvent(s, { result: "done", total_cost_usd: 0.12, num_turns: 2, session_id: "abc" });
  assert.equal(s.result, "done");
  assert.equal(s.cost, 0.12);
  assert.equal(s.turns, 2);
  assert.equal(s.sessionId, "abc");
});

test("isInputWaitEvent matches wait events and messages", () => {
  assert.equal(isInputWaitEvent({ type: "user_input_required" }), true);
  assert.equal(isInputWaitEvent({ type: "system", message: "Waiting for user input to continue" }), true);
  assert.equal(isInputWaitEvent({ type: "assistant", message: "continuing work" }), false);
});

test("createProjectConfig fails when marker already exists", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "roundsman-test-"));
  fs.writeFileSync(path.join(dir, ".roundsman"), "");
  const out = createProjectConfig(dir);
  assert.equal(out.ok, false);
  assert.match(out.error, /project marker already exists/);
});

test("createProjectConfig creates missing target directories", () => {
  const dir = path.join(os.tmpdir(), `roundsman-missing-${Date.now()}`);
  const out = createProjectConfig(dir);
  assert.equal(out.ok, true);
  assert.equal(fs.existsSync(dir), true);
  assert.equal(fs.existsSync(path.join(dir, "roundsman.json")), true);
});

test("stopLoop kills loop process and requeues", () => {
  let killed = 0;
  const q = [];
  const p = { name: "a", loop: { done: 0, max: 2, goal: "x" }, proc: { kill() { killed += 1; } }, state: "working", stopReason: "" };
  assert.equal(stopLoop(p, q, "requested"), true);
  assert.equal(p.loop, null);
  assert.equal(p.state, "idle");
  assert.equal(p.stopReason, "requested");
  assert.equal(killed, 1);
  assert.deepEqual(q, [p]);
});

test("killProject kills non-loop process and requeues", () => {
  let killed = 0;
  const q = [];
  const p = { name: "a", loop: null, proc: { kill() { killed += 1; } }, state: "working", snoozeUntil: 10, stopReason: "" };
  assert.equal(killProject(p, q, "requested"), true);
  assert.equal(p.state, "idle");
  assert.equal(p.snoozeUntil, 0);
  assert.equal(p.stopReason, "requested");
  assert.equal(killed, 1);
  assert.deepEqual(q, [p]);
});

test("snoozeProject then refreshSnoozed wakes project", async () => {
  const p = { name: "a", loop: null, proc: null, state: "idle", snoozeUntil: 0 };
  const q = [p];
  snoozeProject(p, q, 1);
  assert.equal(p.state, "snoozed");
  assert.equal(q.length, 0);
  await new Promise((r) => setTimeout(r, 5));
  refreshSnoozed([p], q);
  assert.equal(p.state, "idle");
  assert.deepEqual(q, [p]);
});

test("dropProject removes from queue and marks dropped", () => {
  const p = { name: "a", loop: null, proc: null, state: "idle", snoozeUntil: 1000 };
  const q = [p];
  dropProject(p, q);
  assert.equal(p.state, "dropped");
  assert.equal(p.snoozeUntil, 0);
  assert.equal(q.length, 0);
});
