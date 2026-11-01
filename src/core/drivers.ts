/**
 * ASD Session Drivers Management API (CR-01)
 */

import * as fs from "node:fs";
import * as path from "node:path";
import {
  type DriverDetachReason,
  type DriverRow,
  type DriverSource,
  generateDriverId,
  type SqliteDriver,
} from "./db.ts";
import { atomicWriteFileSync } from "./render.ts";
import { recordCliRecentSession } from "./session-tracker.ts";
import type {
  HarnessId,
  MainSessionDriverMeta,
  MainSessionMeta,
  SessionPhase,
} from "./types.ts";

export type { DriverDetachReason, DriverRow, DriverSource };

function formatDriverForMainJson(row: DriverRow): MainSessionDriverMeta {
  return {
    driverId: row.driver_id,
    harness: row.harness,
    model: row.model ?? null,
    harnessSessionId: row.harness_session_id ?? null,
    source: row.source,
    attachedAt: row.attached_at,
    detachedAt: row.detached_at ?? null,
    detachReason: row.detach_reason ?? null,
  };
}

export function syncSessionDriversToMainJson(
  db: SqliteDriver,
  projectRoot: string,
  sessionId: string
): void {
  const sessionRow = db.getSession(sessionId);
  if (!sessionRow) return;

  const drivers = db.listDrivers(sessionId);
  const active = db.getActiveDriver(sessionId) ?? null;

  const sessionDir = path.join(path.resolve(projectRoot), ".asd", "sessions", sessionId);
  fs.mkdirSync(sessionDir, { recursive: true });
  const mainJsonPath = path.join(sessionDir, "main.json");

  let existing: Record<string, unknown> = {};
  if (fs.existsSync(mainJsonPath)) {
    try {
      existing = JSON.parse(fs.readFileSync(mainJsonPath, "utf8")) as Record<string, unknown>;
    } catch {
      existing = {};
    }
  }

  const effectiveHarness =
    active?.harness ?? ((sessionRow.main_harness as HarnessId) || "claude-code");
  const effectiveModel = active ? active.model : (sessionRow.main_model ?? null);
  const effectiveSid = active
    ? active.harness_session_id
    : (sessionRow.harness_session_id ?? null);

  const nextMeta: MainSessionMeta & Record<string, unknown> = {
    ...existing,
    sessionId,
    roleType: "main",
    harness: effectiveHarness,
    ...(effectiveModel ? { model: effectiveModel } : {}),
    harnessSessionId: effectiveSid ?? null,
    autoApprove: sessionRow.auto_approve !== 0,
    activeDriverId: active ? active.driver_id : null,
    drivers: drivers.map(formatDriverForMainJson),
    role: "director",
    phase: (sessionRow.phase as SessionPhase) || "planning",
    pid: sessionRow.main_pid ?? process.pid,
    startedAt:
      typeof existing.startedAt === "string"
        ? existing.startedAt
        : new Date(sessionRow.created_at).toISOString(),
    ...(sessionRow.memo ? { memo: sessionRow.memo } : {}),
  };

  if (!effectiveModel && "model" in nextMeta) {
    delete nextMeta.model;
  }

  atomicWriteFileSync(mainJsonPath, JSON.stringify(nextMeta, null, 2) + "\n");
}

export function attachDriver(
  db: SqliteDriver,
  input: {
    projectRoot: string;
    sessionId: string;
    harness: HarnessId;
    model?: string | null;
    harnessSessionId?: string | null;
    source: DriverSource;
    now?: number;
  }
): { driver: DriverRow; previousDriverId: string | null; changed: boolean } {
  const now = input.now ?? Date.now();
  const nextSid = input.harnessSessionId ?? null;
  const hasModelInput = input.model !== undefined;
  const nextModel = input.model ?? null;

  const txResult = db.withImmediateTx(() => {
    const session = db.getSession(input.sessionId);
    if (!session) {
      throw new Error(`Session not found: ${input.sessionId}`);
    }

    const active = db.getActiveDriver(input.sessionId);
    if (
      active &&
      active.harness === input.harness &&
      (active.harness_session_id ?? null) === nextSid
    ) {
      if (hasModelInput && nextModel !== (active.model ?? null)) {
        db["db"]
          .prepare("UPDATE session_drivers SET model = ? WHERE driver_id = ?")
          .run(nextModel, active.driver_id);
        db.updateSessionHarnessInfo(input.sessionId, {
          mainModel: nextModel,
        });
        db.incrementStateVersion(input.sessionId);
      }
      const refreshed = db.getDriver(active.driver_id) ?? active;
      return {
        driver: refreshed,
        previousDriverId: active.driver_id,
        changed: false,
      };
    }

    const previousDriverId = active ? active.driver_id : null;
    if (active) {
      db.detachDriverRow(active.driver_id, "switched", now);
    }

    const newDriver = db.insertDriver({
      driver_id: generateDriverId(now),
      session_id: input.sessionId,
      harness: input.harness,
      model: nextModel,
      harness_session_id: nextSid,
      source: input.source,
      attached_at: now,
      briefing_injected: 0,
    });

    db.updateSessionHarnessInfo(input.sessionId, {
      mainHarness: input.harness,
      mainModel: nextModel,
      harnessSessionId: nextSid,
    });
    db.incrementStateVersion(input.sessionId);

    return {
      driver: newDriver,
      previousDriverId,
      changed: true,
    };
  });

  syncSessionDriversToMainJson(db, input.projectRoot, input.sessionId);

  if (nextSid) {
    recordCliRecentSession(input.projectRoot, {
      harnessSessionId: nextSid,
      harness: input.harness,
      model: txResult.driver.model ?? null,
      asdSessionId: input.sessionId,
    });
  }

  return txResult;
}

export function setDriverHarnessSessionId(
  db: SqliteDriver,
  input: {
    projectRoot: string;
    driverId: string;
    harnessSessionId: string;
  }
): DriverRow {
  const sid = input.harnessSessionId.trim();
  if (!sid) {
    throw new Error("harnessSessionId must be a non-empty string");
  }

  const updated = db.withImmediateTx(() => {
    const existing = db.getDriver(input.driverId);
    if (!existing) {
      throw new Error(`Driver not found: ${input.driverId}`);
    }
    if (
      existing.harness_session_id !== null &&
      existing.harness_session_id !== undefined
    ) {
      if (existing.harness_session_id === sid) {
        return existing;
      }
      throw new Error(
        `Driver ${input.driverId} already has harness_session_id '${existing.harness_session_id}'`
      );
    }

    db.setDriverHarnessSessionId(input.driverId, sid);
    if (existing.detached_at === null) {
      db.updateSessionHarnessInfo(existing.session_id, {
        harnessSessionId: sid,
      });
    }
    db.incrementStateVersion(existing.session_id);
    return db.getDriver(input.driverId)!;
  });

  syncSessionDriversToMainJson(db, input.projectRoot, updated.session_id);
  recordCliRecentSession(input.projectRoot, {
    harnessSessionId: sid,
    harness: updated.harness,
    model: updated.model ?? null,
    asdSessionId: updated.session_id,
  });

  return updated;
}

export function detachDriver(
  db: SqliteDriver,
  input: {
    projectRoot: string;
    driverId: string;
    reason: DriverDetachReason;
  }
): void {
  const sessionId = db.withImmediateTx(() => {
    const existing = db.getDriver(input.driverId);
    if (!existing) {
      throw new Error(`Driver not found: ${input.driverId}`);
    }
    if (existing.detached_at === null) {
      db.detachDriverRow(input.driverId, input.reason, Date.now());
      db.incrementStateVersion(existing.session_id);
    }
    return existing.session_id;
  });

  syncSessionDriversToMainJson(db, input.projectRoot, sessionId);
}

export function getActiveDriver(
  db: SqliteDriver,
  sessionId: string
): DriverRow | null {
  return db.getActiveDriver(sessionId) ?? null;
}

export function listDrivers(db: SqliteDriver, sessionId: string): DriverRow[] {
  return db.listDrivers(sessionId);
}
