/**
 * Phase 0 runtime tests (IMPLEMENTATION_PLAN.md lines 303-306):
 *  1. Direct .ts execution with zero ExperimentalWarning on stderr.
 *  2. node:sqlite in-memory: WAL/busy_timeout pragmas + BEGIN IMMEDIATE round-trip.
 *  3. CRLF chunked line framing + stdout isolation + malformed JSON (-32700).
 *  4. notifications/progress streaming + notifications/cancelled aborts the
 *     handler's AbortSignal; clean exit.
 *  5. stdin close aborts all in-flight requests; clean exit.
 *
 * The StdioRpcServer is exercised only through spawned child processes so its
 * `console.log = console.error` hijack never affects this test runner.
 */

import { test, describe, after } from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath, pathToFileURL } from "node:url";
import path from "node:path";

const projectRoot = path.resolve(fileURLToPath(import.meta.url), "..", "..");
const stdioRpcUrl = pathToFileURL(path.join(projectRoot, "src", "mcp", "stdio-rpc.ts")).href;
const typesUrl = pathToFileURL(path.join(projectRoot, "src", "core", "types.ts")).href;

const children: ChildProcess[] = [];

after(() => {
  for (const child of children) killTree(child);
});

function killTree(child: ChildProcess): void {
  if (child.exitCode !== null || child.signalCode !== null) return;
  if (child.pid === undefined) return;
  if (process.platform === "win32") {
    spawnSync("taskkill", ["/PID", String(child.pid), "/T", "/F"], { stdio: "ignore", windowsHide: true });
  } else {
    try {
      child.kill("SIGKILL");
    } catch {
      // already dead
    }
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

interface Harness {
  child: ChildProcess;
  sendRaw(chunk: string): void;
  send(message: unknown): void;
  waitFor(predicate: (msg: any) => boolean, timeoutMs?: number): Promise<any>;
  stderrText(): string;
  rawStdoutText(): string;
  endStdin(): void;
  waitExit(timeoutMs?: number): Promise<number | null>;
}

/** Spawn `node --no-warnings --input-type=module -e <script>` running `body` with `m` = stdio-rpc module. */
function spawnHarness(body: string): Harness {
  const script = `const m = await import(${JSON.stringify(stdioRpcUrl)});\n${body}`;
  const child = spawn(process.execPath, ["--no-warnings", "--input-type=module", "-e", script], {
    cwd: projectRoot,
    stdio: ["pipe", "pipe", "pipe"],
    windowsHide: true,
  });
  children.push(child);

  let stdoutBuf = "";
  let rawStdout = "";
  let stderr = "";
  const messages: unknown[] = [];
  const waiters: Array<{ predicate: (msg: any) => boolean; resolve: (msg: any) => void; timer: NodeJS.Timeout }> = [];

  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (d: string) => {
    stdoutBuf += d;
    let nl = stdoutBuf.indexOf("\n");
    while (nl !== -1) {
      const line = stdoutBuf.slice(0, nl).replace(/\r$/, "");
      stdoutBuf = stdoutBuf.slice(nl + 1);
      nl = stdoutBuf.indexOf("\n");
      if (line.trim() === "") continue;
      let parsed: unknown;
      try {
        parsed = JSON.parse(line);
      } catch {
        rawStdout += line + "\n"; // non-JSON on stdout = isolation failure evidence
        continue;
      }
      messages.push(parsed);
      for (let i = waiters.length - 1; i >= 0; i--) {
        const waiter = waiters[i]!;
        if (waiter.predicate(parsed)) {
          clearTimeout(waiter.timer);
          waiters.splice(i, 1);
          waiter.resolve(parsed);
        }
      }
    }
  });
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (d: string) => {
    stderr += d;
  });

  function waitFor(predicate: (msg: any) => boolean, timeoutMs = 10000): Promise<any> {
    for (const msg of messages) {
      if (predicate(msg)) return Promise.resolve(msg);
    }
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        const idx = waiters.findIndex((w) => w.timer === timer);
        if (idx !== -1) waiters.splice(idx, 1);
        reject(new Error(`timeout waiting for message; stderr tail: ${stderr.slice(-400)}`));
      }, timeoutMs);
      waiters.push({ predicate, resolve, timer });
    });
  }

  return {
    child,
    sendRaw(chunk) {
      child.stdin.write(chunk);
    },
    send(message) {
      child.stdin.write(JSON.stringify(message) + "\n");
    },
    waitFor,
    stderrText() {
      return stderr;
    },
    rawStdoutText() {
      return rawStdout;
    },
    endStdin() {
      child.stdin.end();
    },
    waitExit(timeoutMs = 10000) {
      return new Promise((resolve, reject) => {
        if (child.exitCode !== null || child.signalCode !== null) {
          resolve(child.exitCode);
          return;
        }
        const timer = setTimeout(() => reject(new Error("child did not exit in time")), timeoutMs);
        child.once("exit", (code) => {
          clearTimeout(timer);
          resolve(code);
        });
      });
    },
  };
}

describe("phase 0 runtime", () => {
  test("direct .ts execution succeeds with zero ExperimentalWarning on stderr", async () => {
    const child = spawn(
      process.execPath,
      [
        "--no-warnings",
        "--input-type=module",
        "-e",
        `const m = await import(${JSON.stringify(typesUrl)}); console.log("types-loaded:" + m.ASD_VERSION);`,
      ],
      { cwd: projectRoot, stdio: ["ignore", "pipe", "pipe"], windowsHide: true },
    );
    children.push(child);
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (d: string) => {
      stdout += d;
    });
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (d: string) => {
      stderr += d;
    });
    const code = await new Promise<number | null>((resolve) => child.once("exit", resolve));
    assert.equal(code, 0);
    assert.ok(stdout.includes("types-loaded:"), `stdout: ${stdout}`);
    assert.equal(stderr.includes("ExperimentalWarning"), false, `stderr must have no ExperimentalWarning: ${stderr}`);
  });

  test("node:sqlite in-memory: WAL/busy_timeout pragmas + BEGIN IMMEDIATE round-trip", () => {
    const db = new DatabaseSync(":memory:");
    db.exec("PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000;");
    const pragma = db.prepare("PRAGMA busy_timeout").get() as { timeout: number };
    assert.equal(pragma.timeout, 5000);
    db.exec("BEGIN IMMEDIATE;");
    db.exec("CREATE TABLE sample (id INTEGER PRIMARY KEY, name TEXT NOT NULL);");
    db.exec("INSERT INTO sample (name) VALUES ('asd');");
    db.exec("COMMIT;");
    const saved = db.prepare("SELECT name FROM sample WHERE id = 1").get() as { name: string };
    assert.equal(saved.name, "asd");
    db.close();
  });

  test("CRLF chunked framing, stdout isolation, malformed JSON -32700 without crash", async () => {
    const h = spawnHarness(`
      const srv = new m.StdioRpcServer({
        handleRequest: async (method, params) => {
          console.log("accidental-log-" + method);
          return { echoed: params, method };
        },
      });
      srv.start();
    `);

    // one request split across two chunks, CRLF terminated
    const req = JSON.stringify({ jsonrpc: "2.0", id: 7, method: "echo", params: { x: 1 } });
    const mid = Math.floor(req.length / 2);
    h.sendRaw(req.slice(0, mid));
    await sleep(60);
    h.sendRaw(req.slice(mid) + "\r\n");
    const resp = await h.waitFor((msg) => msg.id === 7 && msg.result !== undefined);
    assert.equal(resp.jsonrpc, "2.0");
    assert.equal(resp.result.method, "echo");
    assert.deepEqual(resp.result.echoed, { x: 1 });

    // two requests in a single chunk, CRLF separated
    const a = JSON.stringify({ jsonrpc: "2.0", id: 10, method: "echo", params: "a" });
    const b = JSON.stringify({ jsonrpc: "2.0", id: 11, method: "echo", params: "b" });
    h.sendRaw(a + "\r\n" + b + "\r\n");
    const ra = await h.waitFor((msg) => msg.id === 10);
    const rb = await h.waitFor((msg) => msg.id === 11);
    assert.equal(ra.result.echoed, "a");
    assert.equal(rb.result.echoed, "b");

    // stdout isolation: console.log inside the server must land on stderr only
    assert.ok(h.stderrText().includes("accidental-log-echo"), "console.log output must go to stderr");
    assert.equal(h.rawStdoutText().includes("accidental-log"), false, "stdout must contain only JSON-RPC frames");

    // malformed JSON -> -32700, server keeps running
    h.sendRaw("this is not json\r\n");
    const errResp = await h.waitFor((msg) => msg.error !== undefined && msg.error.code === -32700);
    assert.equal(errResp.id, null);
    h.send({ jsonrpc: "2.0", id: 12, method: "echo", params: { y: 2 } });
    const alive = await h.waitFor((msg) => msg.id === 12);
    assert.deepEqual(alive.result.echoed, { y: 2 });
  });

  test("notifications/progress streams and notifications/cancelled aborts the handler signal", async () => {
    const h = spawnHarness(`
      let srv;
      srv = new m.StdioRpcServer({
        handleRequest: async (method, params, signal) => {
          if (method === "long") {
            await new Promise((resolve, reject) => {
              const iv = setInterval(() => srv.sendProgress(1, 50, 100, "working"), 40);
              signal.addEventListener("abort", () => {
                clearInterval(iv);
                reject(new Error("aborted=" + signal.aborted));
              });
            });
          }
          return { pong: true };
        },
      });
      srv.start();
    `);

    h.send({ jsonrpc: "2.0", id: 1, method: "long", params: {} });
    const progress = await h.waitFor((msg) => msg.method === "notifications/progress");
    assert.equal(progress.jsonrpc, "2.0");
    assert.equal(progress.params.progressToken, 1);
    assert.equal(progress.params.progress, 50);
    assert.equal(progress.params.total, 100);
    assert.equal(progress.params.message, "working");

    h.send({ jsonrpc: "2.0", method: "notifications/cancelled", params: { requestId: 1 } });
    const errResp = await h.waitFor((msg) => msg.id === 1 && msg.error !== undefined);
    assert.ok(
      String(errResp.error.message).includes("aborted=true"),
      `handler AbortSignal must be aborted: ${errResp.error.message}`,
    );

    // server stays healthy after cancellation
    h.send({ jsonrpc: "2.0", id: 2, method: "ping" });
    const pong = await h.waitFor((msg) => msg.id === 2 && msg.result !== undefined);
    assert.equal(pong.result.pong, true);

    h.endStdin();
    assert.equal(await h.waitExit(), 0);
  });

  test("stdin close aborts all in-flight requests and the process exits cleanly", async () => {
    const h = spawnHarness(`
      let srv;
      srv = new m.StdioRpcServer({
        handleRequest: async (method, params, signal) => {
          if (method === "long") {
            await new Promise((resolve, reject) => {
              const iv = setInterval(() => srv.sendProgress(2, 1, 10, "working"), 40);
              signal.addEventListener("abort", () => {
                clearInterval(iv);
                reject(new Error("aborted=" + signal.aborted));
              });
            });
          }
          return null;
        },
      });
      srv.start();
    `);

    h.send({ jsonrpc: "2.0", id: 5, method: "long", params: {} });
    await h.waitFor((msg) => msg.method === "notifications/progress");
    h.endStdin();
    const errResp = await h.waitFor((msg) => msg.id === 5 && msg.error !== undefined);
    assert.ok(String(errResp.error.message).includes("aborted=true"));
    assert.equal(await h.waitExit(), 0);
  });
});
