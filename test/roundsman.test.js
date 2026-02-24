const test = require("node:test");
const assert = require("node:assert/strict");

const {
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
