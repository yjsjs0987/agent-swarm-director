/**
 * CR-11: Cross-Process Merge Lock (.asd/merge.lock) Tests
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import * as child_process from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { withMergeLock, rollbackLightChanges } from "../src/core/workspace.ts";

const workspaceModuleUrl = new URL("../src/core/workspace.ts", import.meta.url).href;

function makeTempDir(prefix = "asd-merge-lock-"): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

describe("CR-11: Cross-Process Merge Lock (.asd/merge.lock)", () => {
  it("1. two child processes acquiring withMergeLock execute serially without overlap", async () => {
    const tmpDir = makeTempDir();
    try {
      const workerCode = [
        `import { withMergeLock } from ${JSON.stringify(workspaceModuleUrl)};`,
        `const projectRoot = process.argv[1];`,
        `const label = process.argv[2];`,
        `const holdMs = Number(process.argv[3] || 350);`,
        `await withMergeLock(`,
        `  async () => {`,
        `    const enteredAt = Date.now();`,
        `    await new Promise((r) => setTimeout(r, holdMs));`,
        `    const exitedAt = Date.now();`,
        `    console.log(JSON.stringify({ label, enteredAt, exitedAt }));`,
        `  },`,
        `  { projectRoot, purpose: "child-" + label, timeoutMs: 15000 }`,
        `);`,
      ].join("\n");

      const runChild = (label: string, holdMs: number) =>
        new Promise<{ label: string; enteredAt: number; exitedAt: number }>((resolve, reject) => {
          const proc = child_process.spawn(
            process.execPath,
            ["--no-warnings", "--input-type=module", "-", tmpDir, label, String(holdMs)],
            { stdio: ["pipe", "pipe", "pipe"], windowsHide: true }
          );
          let stdout = "";
          let stderr = "";
          proc.stdout.on("data", (d) => (stdout += d.toString()));
          proc.stderr.on("data", (d) => (stderr += d.toString()));
          proc.on("error", reject);
          proc.on("close", (code) => {
            if (code !== 0) {
              reject(new Error(`Child ${label} exited with ${code}: ${stderr || stdout}`));
              return;
            }
            const line = stdout.trim().split(/\r?\n/).pop() || "";
            resolve(JSON.parse(line));
          });
          proc.stdin.end(workerCode);
        });

      const [resA, resB] = await Promise.all([
        runChild("A", 350),
        runChild("B", 350),
      ]);

      const [first, second] =
        resA.enteredAt <= resB.enteredAt ? [resA, resB] : [resB, resA];

      assert.ok(
        second.enteredAt >= first.exitedAt - 15,
        `Expected serial execution without overlap, got first=${JSON.stringify(first)}, second=${JSON.stringify(second)}`
      );
      assert.equal(
        fs.existsSync(path.join(tmpDir, ".asd", "merge.lock")),
        false,
        "merge.lock should be removed after completion"
      );
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("2. automatically reclaims stale lock from a dead PID or >10 minute old timestamp", async () => {
    const tmpDir = makeTempDir();
    try {
      const lockPath = path.join(tmpDir, ".asd", "merge.lock");
      fs.mkdirSync(path.dirname(lockPath), { recursive: true });

      // Case A: Dead PID (99999999)
      fs.writeFileSync(
        lockPath,
        JSON.stringify({
          pid: 99999999,
          hostname: os.hostname(),
          acquiredAt: Date.now(),
          purpose: "dead-process",
        }),
        "utf8"
      );

      let ranWithDeadPid = false;
      await withMergeLock(
        async () => {
          ranWithDeadPid = true;
          const current = JSON.parse(fs.readFileSync(lockPath, "utf8"));
          assert.equal(current.pid, process.pid);
        },
        { projectRoot: tmpDir, purpose: "reclaim-dead-pid", timeoutMs: 2000 }
      );
      assert.equal(ranWithDeadPid, true);
      assert.equal(fs.existsSync(lockPath), false);

      // Case B: Live PID (process.pid) but acquiredAt > 10 minutes ago
      fs.writeFileSync(
        lockPath,
        JSON.stringify({
          pid: process.pid,
          hostname: os.hostname(),
          acquiredAt: Date.now() - 11 * 60 * 1000,
          purpose: "expired-lock",
        }),
        "utf8"
      );

      let ranWithExpiredLock = false;
      await withMergeLock(
        async () => {
          ranWithExpiredLock = true;
        },
        { projectRoot: tmpDir, purpose: "reclaim-expired", timeoutMs: 2000 }
      );
      assert.equal(ranWithExpiredLock, true);
      assert.equal(fs.existsSync(lockPath), false);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("3. throws Error('MERGE_LOCK_TIMEOUT') when active lock is held past timeoutMs", async () => {
    const tmpDir = makeTempDir();
    try {
      const lockPath = path.join(tmpDir, ".asd", "merge.lock");
      fs.mkdirSync(path.dirname(lockPath), { recursive: true });

      const sleeper = child_process.spawn(
        process.execPath,
        ["-e", "setTimeout(() => {}, 10000)"],
        { stdio: "ignore", windowsHide: true }
      );

      try {
        assert.ok(sleeper.pid, "Sleeper child should have a valid PID");
        fs.writeFileSync(
          lockPath,
          JSON.stringify({
            pid: sleeper.pid,
            hostname: os.hostname(),
            acquiredAt: Date.now(),
            purpose: "held-by-live-child",
          }),
          "utf8"
        );

        await assert.rejects(
          () =>
            withMergeLock(async () => "should-not-run", {
              projectRoot: tmpDir,
              purpose: "timeout-test",
              timeoutMs: 450,
            }),
          (err: unknown) => {
            assert.ok(err instanceof Error);
            assert.equal(err.message, "MERGE_LOCK_TIMEOUT");
            return true;
          }
        );

        assert.equal(fs.existsSync(lockPath), true);
      } finally {
        try {
          sleeper.kill();
        } catch {
          // ignore
        }
      }
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("4. supports re-entrant synchronous lock helpers inside withMergeLock without deadlock", async () => {
    const tmpDir = makeTempDir();
    try {
      let innerCompleted = false;
      await withMergeLock(
        async () => {
          rollbackLightChanges(tmpDir);
          innerCompleted = true;
        },
        { projectRoot: tmpDir, purpose: "outer-lock", timeoutMs: 2000 }
      );
      assert.equal(innerCompleted, true);
      assert.equal(fs.existsSync(path.join(tmpDir, ".asd", "merge.lock")), false);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});