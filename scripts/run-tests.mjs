#!/usr/bin/env node
/**
 * Runs the ASD test suite with ASD_HOME_DIR pointed at a throwaway temp dir.
 *
 * Why: tests create temp *projects* but historically fell back to the real
 * ~/.asd for the *home* dir, polluting it with one state dir per run. With the
 * single shared state DB (state/core.db) that pollution would now land test
 * rows in the real DB, so home isolation is mandatory for `npm test`.
 */
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

const home = fs.mkdtempSync(path.join(os.tmpdir(), "asd-test-home-"));
process.env.ASD_HOME_DIR = home;

const args = process.argv.slice(2);
const testArgs = ["--no-warnings", "--test", ...(args.length > 0 ? args : ["tests/*.test.ts"])];
const res = spawnSync(process.execPath, testArgs, { stdio: "inherit", env: process.env });

try {
  fs.rmSync(home, { recursive: true, force: true, maxRetries: 3 });
} catch {
  // temp home cleanup is best-effort
}
process.exit(res.status ?? 1);
