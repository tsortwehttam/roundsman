const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawn } = require("node:child_process");
const { EventEmitter, once } = require("node:events");

function mkdtemp(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`, "utf-8");
}

function shQuote(v) {
  return `"${String(v).replace(/(["\\$`])/g, "\\$1")}"`;
}

function makeCollector(proc) {
  const bus = new EventEmitter();
  let out = "";
  const onData = (chunk) => {
    out += String(chunk);
    bus.emit("data");
  };
  proc.stdout.on("data", onData);
  proc.stderr.on("data", onData);
  return {
    read() {
      return out;
    },
    async waitFor(pattern, timeoutMs = 15000) {
      if (pattern.test(out)) return out;
      return new Promise((resolve, reject) => {
        let done = false;
        const onTick = () => {
          if (done) return;
          if (!pattern.test(out)) return;
          done = true;
          clearTimeout(timer);
          bus.off("data", onTick);
          proc.off("exit", onExit);
          resolve(out);
        };
        const onExit = (code) => {
          if (done) return;
          done = true;
          clearTimeout(timer);
          bus.off("data", onTick);
          reject(new Error(`process exited early (${code}) while waiting for ${pattern}`));
        };
        const timer = setTimeout(() => {
          if (done) return;
          done = true;
          bus.off("data", onTick);
          proc.off("exit", onExit);
          reject(new Error(`timeout waiting for ${pattern}\n\n${out}`));
        }, timeoutMs);
        bus.on("data", onTick);
        proc.on("exit", onExit);
      });
    },
    async waitForCount(needle, count, timeoutMs = 15000) {
      const esc = needle.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      const rx = new RegExp(esc, "g");
      const hasCount = () => (out.match(rx) || []).length >= count;
      if (hasCount()) return out;
      return new Promise((resolve, reject) => {
        let done = false;
        const onTick = () => {
          if (done) return;
          if (!hasCount()) return;
          done = true;
          clearTimeout(timer);
          bus.off("data", onTick);
          proc.off("exit", onExit);
          resolve(out);
        };
        const onExit = (code) => {
          if (done) return;
          done = true;
          clearTimeout(timer);
          bus.off("data", onTick);
          reject(new Error(`process exited early (${code}) while waiting for ${needle} x${count}`));
        };
        const timer = setTimeout(() => {
          if (done) return;
          done = true;
          bus.off("data", onTick);
          proc.off("exit", onExit);
          reject(new Error(`timeout waiting for ${needle} x${count}\n\n${out}`));
        }, timeoutMs);
        bus.on("data", onTick);
        proc.on("exit", onExit);
      });
    },
  };
}

test("integration: broadcast shows agent output while waiting", async () => {
  const tempRoot = mkdtemp("roundsman-it-");
  const xdgRoot = mkdtemp("roundsman-xdg-");
  const roundsmanPath = path.resolve(__dirname, "..", "roundsman.js");
  const mockAgentPath = path.resolve(__dirname, "fixtures", "mock-agent");
  const dirs = ["a", "b", "c"];
  let proc = null;

  try {
    for (const name of dirs) {
      const dir = path.join(tempRoot, name);
      fs.mkdirSync(dir, { recursive: true });
      writeJson(path.join(dir, "roundsman.json"), {});
    }

    writeJson(path.join(xdgRoot, "roundsman", "config.json"), {
      claudeBin: mockAgentPath,
      defaultPermissionMode: "acceptEdits",
    });

    proc = spawn(process.execPath, [roundsmanPath, tempRoot, "--no-color"], {
      cwd: tempRoot,
      env: { ...process.env, XDG_CONFIG_HOME: xdgRoot, ROUNDSMAN_MOCK_MODE: "normal" },
      stdio: ["pipe", "pipe", "pipe"],
    });
    const c = makeCollector(proc);

    await c.waitFor(/press enter to start \(or q to quit\) >/);
    proc.stdin.write("\n");
    await c.waitFor(/\[R\] a t0/);

    proc.stdin.write("/broadcast smoke run\n");
    await c.waitFor(/broadcasting to 3 project\(s\)\.\.\./);
    await c.waitFor(/No active idle projects\. Waiting\.\.\./);
    await c.waitFor(/\[agent\] mock start/);
    await c.waitFor(/\[output\] ok/);
    await c.waitForCount("[done]", 3);

    const out = c.read();
    const agentIx = out.indexOf("[agent] mock start");
    const doneIx = out.indexOf("[done]");
    assert.ok(agentIx >= 0, "expected agent stream output");
    assert.ok(doneIx >= 0, "expected done output");
    assert.ok(agentIx < doneIx, "expected streamed agent output before done line");
    assert.match(out, /\[stderr\] mock stderr line/);

    proc.stdin.write("/quit\n");
    const [code] = await once(proc, "exit");
    assert.equal(code, 0);
  } finally {
    if (proc && !proc.killed) proc.kill("SIGTERM");
    fs.rmSync(tempRoot, { recursive: true, force: true });
    fs.rmSync(xdgRoot, { recursive: true, force: true });
  }
});

test("integration: buffered output flushes between prompts after skip", async () => {
  const tempRoot = mkdtemp("roundsman-it-");
  const xdgRoot = mkdtemp("roundsman-xdg-");
  const roundsmanPath = path.resolve(__dirname, "..", "roundsman.js");
  const mockAgentPath = path.resolve(__dirname, "fixtures", "mock-agent");
  const dirs = ["a", "b"];
  let proc = null;

  try {
    for (const name of dirs) {
      const dir = path.join(tempRoot, name);
      fs.mkdirSync(dir, { recursive: true });
      writeJson(path.join(dir, "roundsman.json"), {});
    }

    writeJson(path.join(xdgRoot, "roundsman", "config.json"), {
      claudeBin: mockAgentPath,
      defaultPermissionMode: "acceptEdits",
    });

    proc = spawn(process.execPath, [roundsmanPath, tempRoot, "--no-color"], {
      cwd: tempRoot,
      env: { ...process.env, XDG_CONFIG_HOME: xdgRoot, ROUNDSMAN_MOCK_MODE: "wait-buffer" },
      stdio: ["pipe", "pipe", "pipe"],
    });
    const c = makeCollector(proc);

    await c.waitFor(/press enter to start \(or q to quit\) >/);
    proc.stdin.write("\n");
    await c.waitFor(/\[R\] a t0/);

    proc.stdin.write("/work smoke\n");
    await c.waitFor(/\[R\] b t0/);
    await c.waitFor(/\[stopped\] a/);

    proc.stdin.write("/skip\n");
    await c.waitFor(/\[buffered\] 1 message\(s\) while waiting for user input/);
    await c.waitFor(/\[agent\] buffered after wait event/);

    const out = c.read();
    const skipIx = out.indexOf("-> skipped b for 1 round");
    const bufferedIx = out.indexOf("[buffered] 1 message(s) while waiting for user input");
    assert.ok(skipIx >= 0, "expected skip output");
    assert.ok(bufferedIx >= 0, "expected buffered flush output");
    assert.ok(skipIx < bufferedIx, "expected buffered flush after skip command turn");

    proc.stdin.write("/quit\n");
    const [code] = await once(proc, "exit");
    assert.equal(code, 0);
  } finally {
    if (proc && !proc.killed) proc.kill("SIGTERM");
    fs.rmSync(tempRoot, { recursive: true, force: true });
    fs.rmSync(xdgRoot, { recursive: true, force: true });
  }
});

test("integration: buffered output flushes between prompts after workwait", async () => {
  const tempRoot = mkdtemp("roundsman-it-");
  const xdgRoot = mkdtemp("roundsman-xdg-");
  const roundsmanPath = path.resolve(__dirname, "..", "roundsman.js");
  const mockAgentPath = path.resolve(__dirname, "fixtures", "mock-agent");
  const dirs = ["a", "b"];
  let proc = null;

  try {
    for (const name of dirs) {
      const dir = path.join(tempRoot, name);
      fs.mkdirSync(dir, { recursive: true });
      writeJson(path.join(dir, "roundsman.json"), {});
    }

    writeJson(path.join(xdgRoot, "roundsman", "config.json"), {
      claudeBin: mockAgentPath,
      defaultPermissionMode: "acceptEdits",
    });

    proc = spawn(process.execPath, [roundsmanPath, tempRoot, "--no-color"], {
      cwd: tempRoot,
      env: { ...process.env, XDG_CONFIG_HOME: xdgRoot, ROUNDSMAN_MOCK_MODE: "wait-buffer" },
      stdio: ["pipe", "pipe", "pipe"],
    });
    const c = makeCollector(proc);

    await c.waitFor(/press enter to start \(or q to quit\) >/);
    proc.stdin.write("\n");
    await c.waitFor(/\[R\] a t0/);

    proc.stdin.write("/workwait smoke\n");
    await c.waitFor(/-> wait complete for a/);
    await c.waitFor(/\[buffered\] 1 message\(s\) while waiting for user input/);
    await c.waitFor(/\[agent\] buffered after wait event/);

    const out = c.read();
    const doneIx = out.indexOf("-> wait complete for a");
    const bufferedIx = out.indexOf("[buffered] 1 message(s) while waiting for user input");
    assert.ok(doneIx >= 0, "expected workwait completion");
    assert.ok(bufferedIx >= 0, "expected buffered flush output");
    assert.ok(doneIx < bufferedIx, "expected buffered flush after workwait completion");

    proc.stdin.write("/quit\n");
    const [code] = await once(proc, "exit");
    assert.equal(code, 0);
  } finally {
    if (proc && !proc.killed) proc.kill("SIGTERM");
    fs.rmSync(tempRoot, { recursive: true, force: true });
    fs.rmSync(xdgRoot, { recursive: true, force: true });
  }
});

test("integration: watch output prints while no idle projects are waiting", async () => {
  const tempRoot = mkdtemp("roundsman-it-");
  const xdgRoot = mkdtemp("roundsman-xdg-");
  const roundsmanPath = path.resolve(__dirname, "..", "roundsman.js");
  const mockAgentPath = path.resolve(__dirname, "fixtures", "mock-agent");
  const watchPath = path.resolve(__dirname, "fixtures", "watch-emitter");
  let proc = null;

  try {
    const dir = path.join(tempRoot, "a");
    fs.mkdirSync(dir, { recursive: true });
    writeJson(path.join(dir, "roundsman.json"), {
      watch: `${shQuote(process.execPath)} ${shQuote(watchPath)}`,
    });

    writeJson(path.join(xdgRoot, "roundsman", "config.json"), {
      claudeBin: mockAgentPath,
      defaultPermissionMode: "acceptEdits",
    });

    proc = spawn(process.execPath, [roundsmanPath, tempRoot, "--no-color"], {
      cwd: tempRoot,
      env: { ...process.env, XDG_CONFIG_HOME: xdgRoot, ROUNDSMAN_MOCK_MODE: "normal" },
      stdio: ["pipe", "pipe", "pipe"],
    });
    const c = makeCollector(proc);

    await c.waitFor(/press enter to start \(or q to quit\) >/);
    proc.stdin.write("\n");
    await c.waitFor(/\[R\] a t0/);

    proc.stdin.write("/watch\n");
    await c.waitFor(/No active idle projects\. Waiting\.\.\./);
    await c.waitFor(/\[watch\] watch out 1/);
    await c.waitFor(/\[watch stderr\] watch err 1/);
    await c.waitFor(/\[watch ready\] a .*exit=0/);
    await c.waitForCount("[R] a t0", 2);

    proc.stdin.write("/quit\n");
    const [code] = await once(proc, "exit");
    assert.equal(code, 0);
  } finally {
    if (proc && !proc.killed) proc.kill("SIGTERM");
    fs.rmSync(tempRoot, { recursive: true, force: true });
    fs.rmSync(xdgRoot, { recursive: true, force: true });
  }
});

test("integration: afterWatchSuccess hook output prints after watch ready", async () => {
  const tempRoot = mkdtemp("roundsman-it-");
  const xdgRoot = mkdtemp("roundsman-xdg-");
  const roundsmanPath = path.resolve(__dirname, "..", "roundsman.js");
  const mockAgentPath = path.resolve(__dirname, "fixtures", "mock-agent");
  const watchPath = path.resolve(__dirname, "fixtures", "watch-emitter");
  const hookPath = path.resolve(__dirname, "fixtures", "hook-echo");
  let proc = null;

  try {
    const dir = path.join(tempRoot, "a");
    fs.mkdirSync(dir, { recursive: true });
    writeJson(path.join(dir, "roundsman.json"), {
      watch: `${shQuote(process.execPath)} ${shQuote(watchPath)}`,
      hooks: {
        afterWatchSuccess: `!${shQuote(process.execPath)} ${shQuote(hookPath)}`,
      },
    });

    writeJson(path.join(xdgRoot, "roundsman", "config.json"), {
      claudeBin: mockAgentPath,
      defaultPermissionMode: "acceptEdits",
    });

    proc = spawn(process.execPath, [roundsmanPath, tempRoot, "--no-color"], {
      cwd: tempRoot,
      env: { ...process.env, XDG_CONFIG_HOME: xdgRoot, ROUNDSMAN_MOCK_MODE: "normal" },
      stdio: ["pipe", "pipe", "pipe"],
    });
    const c = makeCollector(proc);

    await c.waitFor(/press enter to start \(or q to quit\) >/);
    proc.stdin.write("\n");
    await c.waitFor(/\[R\] a t0/);

    proc.stdin.write("/watch\n");
    await c.waitFor(/\[watch ready\] a .*exit=0/);
    await c.waitFor(/\[hook afterWatchSuccess\] hook says hi/);

    const out = c.read();
    const readyIx = out.search(/\[watch ready\] a .*exit=0/);
    const hookIx = out.indexOf("[hook afterWatchSuccess] hook says hi");
    assert.ok(readyIx >= 0, "expected watch ready output");
    assert.ok(hookIx >= 0, "expected hook output");
    assert.ok(readyIx < hookIx, "expected hook output after watch ready");

    proc.stdin.write("/quit\n");
    const [code] = await once(proc, "exit");
    assert.equal(code, 0);
  } finally {
    if (proc && !proc.killed) proc.kill("SIGTERM");
    fs.rmSync(tempRoot, { recursive: true, force: true });
    fs.rmSync(xdgRoot, { recursive: true, force: true });
  }
});
