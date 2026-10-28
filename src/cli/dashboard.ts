/**
 * ASD v2.2 Lightweight Zero-Dependency Web Dashboard (src/cli/dashboard.ts)
 *
 * Uses built-in `node:http` with zero external runtime dependencies.
 * Provides:
 * - `GET /api/state`: Live JSON snapshot of all SQLite sessions (with `.asd` memos),
 *   tasks, debates, subagent logs, and harness availability.
 * - `POST /api/session-memo`: Updates the short session memo in `.asd/core.db`
 *   and `.asd/sessions/<sessionId>/main.json`.
 * - `GET /`: Master-detail dark-mode Web UI grouping sessions by ID + created time +
 *   short memo, with click-to-inspect session tasks, debates, and per-subagent
 *   prompt & output logs.
 */

import * as fs from "node:fs";
import * as http from "node:http";
import * as path from "node:path";

import { runAsdDoctor } from "../adapters/installer.ts";
import { resolveAsdPaths } from "../core/config.ts";
import {
  type DebateRow,
  openProjectDb,
  type SessionRow,
  type SqliteDriver,
  type TaskRow,
} from "../core/db.ts";
import { atomicWriteFileSync } from "../core/render.ts";
import { ASD_VERSION } from "../core/types.ts";
import { scanSubagentLogs, type SubagentLogRecord } from "./index.ts";

export interface DashboardSnapshot {
  version: string;
  projectRoot: string;
  systemLocale: string;
  timestamp: number;
  session: SessionRow | null;
  sessions: SessionRow[];
  tasks: TaskRow[];
  allTasks: TaskRow[];
  debates: DebateRow[];
  allDebates: DebateRow[];
  subagentLogs: SubagentLogRecord[];
  harnesses: Record<
    string,
    { installed: boolean; headlessSupported: boolean; binary?: string; resolvedPath?: string | null }
  >;
}

const doctorCache = new Map<string, DashboardSnapshot["harnesses"]>();

function detectSystemLocale(): string {
  try {
    const resolved = Intl.DateTimeFormat().resolvedOptions().locale;
    if (resolved) return resolved;
  } catch {
    // Ignore
  }
  return process.env.LC_ALL || process.env.LANG || "en-US";
}

function readMainJsonMeta(projectRoot: string, sessionId: string): Record<string, unknown> | null {
  try {
    const mainJsonPath = path.join(projectRoot, ".asd", "sessions", sessionId, "main.json");
    if (!fs.existsSync(mainJsonPath)) return null;
    return JSON.parse(fs.readFileSync(mainJsonPath, "utf8")) as Record<string, unknown>;
  } catch {
    return null;
  }
}

export function saveSessionMemo(options: {
  projectRoot: string;
  homeDir?: string;
  sessionId: string;
  memo: string;
}): { ok: boolean; sessionId: string; memo: string } {
  const projectRoot = path.resolve(options.projectRoot);
  const sessionId = options.sessionId.trim();
  const memo = options.memo.trim().slice(0, 80);

  if (!sessionId || /[\\/]|\.\./.test(sessionId)) {
    throw new Error("Invalid sessionId");
  }

  let db: SqliteDriver | undefined;
  try {
    db = openProjectDb(projectRoot, options.homeDir);
    const existing = db.getSession(sessionId);
    if (!existing) {
      db.createOrGetSession({
        sessionId,
        projectRoot,
        mainHarness: "claude-code",
        memo,
      });
    } else {
      db.updateSessionMemo(sessionId, memo);
    }
  } finally {
    db?.close();
  }

  // Persist memo inside .asd/sessions/<sessionId>/main.json as well
  try {
    const sessionDir = path.join(projectRoot, ".asd", "sessions", sessionId);
    fs.mkdirSync(sessionDir, { recursive: true });
    const mainJsonPath = path.join(sessionDir, "main.json");
    const current = readMainJsonMeta(projectRoot, sessionId) ?? {
      sessionId,
      roleType: "main",
      harness: "claude-code",
      role: "director",
      phase: "planning",
      pid: process.pid,
      startedAt: new Date().toISOString(),
    };
    current.memo = memo;
    atomicWriteFileSync(mainJsonPath, JSON.stringify(current, null, 2) + "\n");
  } catch {
    // Ignore file sync error if SQLite succeeded
  }

  return { ok: true, sessionId, memo };
}

export async function collectDashboardSnapshot(options?: {
  projectRoot?: string;
  homeDir?: string;
}): Promise<DashboardSnapshot> {
  const projectRoot = path.resolve(options?.projectRoot || process.cwd());
  const homeDir = options?.homeDir;
  const paths = resolveAsdPaths(projectRoot, homeDir);

  let session: SessionRow | null = null;
  let sessions: SessionRow[] = [];
  let tasks: TaskRow[] = [];
  let allTasks: TaskRow[] = [];
  let debates: DebateRow[] = [];
  let allDebates: DebateRow[] = [];

  if (fs.existsSync(paths.dbPath)) {
    let db: SqliteDriver | undefined;
    try {
      db = openProjectDb(projectRoot, homeDir);
      sessions = db.listSessions();
      session = sessions[0] ?? null;
      allTasks = db.getAllTasks();
      allDebates = db.getAllDebates();
      if (session) {
        tasks = allTasks.filter((t) => t.session_id === session!.session_id);
        debates = allDebates.filter((d) => d.session_id === session!.session_id);
      }
    } catch {
      // Ignore transient read issues
    } finally {
      db?.close();
    }
  }

  const subagentLogs = scanSubagentLogs(projectRoot);

  // Merge any sessions that exist on disk (.asd/sessions/<id>) or in subagent logs
  // so historical subagent runs are always selectable in the session list.
  const sessionMap = new Map<string, SessionRow>();
  for (const s of sessions) {
    const mainMeta = readMainJsonMeta(projectRoot, s.session_id);
    const diskMemo = typeof mainMeta?.memo === "string" ? mainMeta.memo : "";
    const autoDebateTopic = allDebates.find((d) => d.session_id === s.session_id)?.topic ?? "";
    const autoTaskTitle = allTasks.find((t) => t.session_id === s.session_id)?.title ?? "";
    const effectiveMemo =
      (s.memo && s.memo.trim()) ||
      diskMemo.trim() ||
      autoDebateTopic.slice(0, 40) ||
      autoTaskTitle.slice(0, 40) ||
      "";
    sessionMap.set(s.session_id, {
      ...s,
      memo: effectiveMemo,
    });
  }

  for (const log of subagentLogs) {
    if (!log.sessionId) continue;
    if (!sessionMap.has(log.sessionId)) {
      const mainMeta = readMainJsonMeta(projectRoot, log.sessionId);
      const diskMemo = typeof mainMeta?.memo === "string" ? mainMeta.memo : "";
      sessionMap.set(log.sessionId, {
        session_id: log.sessionId,
        project_root: projectRoot,
        main_harness: log.harness || "claude-code",
        main_pid: null,
        phase: "done",
        state_version: 1,
        base_sha: null,
        stashed_work_sha: null,
        no_progress_count: 0,
        memo: diskMemo || log.taskId || log.role || "",
        created_at: log.startedAt || Date.now(),
        updated_at: log.finishedAt || log.startedAt || Date.now(),
      });
    }
  }

  sessions = [...sessionMap.values()].sort((a, b) => b.created_at - a.created_at);
  if (!session && sessions.length > 0) {
    session = sessions[0]!;
  } else if (session && sessionMap.has(session.session_id)) {
    session = sessionMap.get(session.session_id)!;
  }

  const cacheKey = `${projectRoot}::${homeDir ?? ""}`;
  let harnesses = doctorCache.get(cacheKey);
  if (!harnesses) {
    const doctor = await runAsdDoctor({ projectRoot, homeDir });
    harnesses = doctor.harnesses;
    doctorCache.set(cacheKey, harnesses);
  }

  return {
    version: ASD_VERSION,
    projectRoot,
    systemLocale: detectSystemLocale(),
    timestamp: Date.now(),
    session,
    sessions,
    tasks,
    allTasks,
    debates,
    allDebates,
    subagentLogs,
    harnesses,
  };
}

function renderDashboardHtml(defaultLocale = detectSystemLocale()): string {
  const defaultLang = defaultLocale.toLowerCase().startsWith("ko") ? "ko" : "en";
  return `<!DOCTYPE html>
<html lang="${defaultLang}">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>ASD v${ASD_VERSION} — Multi-Agent Control Plane</title>
  <style>
    :root {
      --bg: #0b0f17;
      --panel: #131b2b;
      --border: #23304a;
      --text: #e6edf3;
      --muted: #8b9bb4;
      --accent: #58a6ff;
      --ok: #3fb950;
      --warn: #d29922;
      --err: #f85149;
    }
    * { box-sizing: border-box; }
    body {
      margin: 0;
      font-family: -apple-system, BlinkMacSystemFont, "Pretendard", "Malgun Gothic", "Segoe UI", Roboto, monospace;
      background: var(--bg);
      color: var(--text);
      line-height: 1.5;
    }
    header {
      display: flex;
      justify-content: space-between;
      align-items: center;
      padding: 14px 24px;
      background: var(--panel);
      border-bottom: 1px solid var(--border);
    }
    header h1 { margin: 0; font-size: 18px; color: var(--accent); }
    .header-right {
      display: flex;
      align-items: center;
      gap: 14px;
    }
    .lang-toggle {
      display: inline-flex;
      border: 1px solid var(--border);
      border-radius: 6px;
      overflow: hidden;
      background: #0d1421;
    }
    .lang-btn {
      background: transparent;
      border: none;
      color: var(--muted);
      padding: 5px 11px;
      font-size: 12px;
      font-weight: 600;
      cursor: pointer;
    }
    .lang-btn.active {
      background: var(--accent);
      color: #0b0f17;
    }
    .meta-bar { font-size: 12px; color: var(--muted); }
    .container {
      display: grid;
      grid-template-columns: 300px 1fr 460px;
      gap: 16px;
      padding: 20px 24px;
      max-width: 1760px;
      margin: 0 auto;
    }
    @media (max-width: 1280px) {
      .container { grid-template-columns: 1fr; }
    }
    .kpis {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(180px, 1fr));
      gap: 12px;
      margin-bottom: 16px;
    }
    .card {
      background: var(--panel);
      border: 1px solid var(--border);
      border-radius: 8px;
      padding: 14px 16px;
    }
    .card-title { font-size: 12px; color: var(--muted); text-transform: uppercase; margin-bottom: 8px; font-weight: 600; }
    .card-value { font-size: 18px; font-weight: 700; word-break: break-all; }
    .progress-bar {
      height: 8px;
      background: #1c273d;
      border-radius: 4px;
      overflow: hidden;
      margin-top: 8px;
    }
    .progress-fill { height: 100%; background: var(--ok); transition: width 0.25s ease; }
    .session-item {
      padding: 10px 12px;
      border: 1px solid var(--border);
      border-radius: 6px;
      margin-bottom: 8px;
      cursor: pointer;
      background: #0f1624;
      transition: border-color 0.15s ease, background 0.15s ease;
    }
    .session-item:hover, .session-item.active {
      border-color: var(--accent);
      background: #162238;
    }
    .session-item-header {
      display: flex;
      justify-content: space-between;
      align-items: center;
      gap: 6px;
      font-size: 13px;
      font-weight: 700;
    }
    .session-memo-row {
      display: flex;
      justify-content: space-between;
      align-items: center;
      gap: 6px;
      margin-top: 4px;
      font-size: 12px;
      color: #c9d1d9;
    }
    .memo-edit-btn {
      background: #1c273d;
      border: 1px solid var(--border);
      color: var(--accent);
      border-radius: 4px;
      padding: 2px 6px;
      font-size: 11px;
      cursor: pointer;
      flex-shrink: 0;
    }
    .memo-edit-btn:hover {
      background: var(--accent);
      color: #0b0f17;
    }
    .task-row {
      display: flex;
      justify-content: space-between;
      align-items: center;
      padding: 10px 12px;
      border: 1px solid var(--border);
      border-radius: 6px;
      margin-bottom: 8px;
      cursor: pointer;
      background: #0f1624;
    }
    .task-row:hover, .task-row.active { border-color: var(--accent); background: #162238; }
    .debate-row {
      border: 1px solid var(--border);
      border-radius: 6px;
      padding: 10px 12px;
      margin-bottom: 8px;
      cursor: pointer;
      background: #0f1624;
    }
    .debate-row:hover, .debate-row.active { border-color: var(--accent); background: #162238; }
    .badge {
      display: inline-block;
      padding: 2px 8px;
      border-radius: 999px;
      font-size: 11px;
      font-weight: 600;
      margin-right: 6px;
    }
    .st-done { background: rgba(63,185,80,0.18); color: var(--ok); }
    .st-running { background: rgba(88,166,255,0.18); color: var(--accent); }
    .st-failed, .st-escalated, .st-merge_conflict { background: rgba(248,81,73,0.18); color: var(--err); }
    .st-pending { background: rgba(139,155,180,0.15); color: var(--muted); }
    pre {
      background: #090d14;
      border: 1px solid var(--border);
      border-radius: 6px;
      padding: 12px;
      overflow-x: auto;
      font-size: 12px;
      max-height: 400px;
      white-space: pre-wrap;
      word-break: break-word;
    }
    .harness-list { display: flex; gap: 8px; flex-wrap: wrap; margin-top: 6px; }
    .pill-scroll {
      display: flex;
      gap: 6px;
      flex-wrap: wrap;
      max-height: 120px;
      overflow-y: auto;
      margin-bottom: 10px;
      padding-bottom: 4px;
    }
  </style>
</head>
<body>
  <header>
    <div>
      <h1 id="headerTitle">ASD Multi-Agent Control Plane (v${ASD_VERSION})</h1>
      <div class="meta-bar" id="projPath">Loading...</div>
    </div>
    <div class="header-right">
      <div class="meta-bar" id="lastUpdated">Auto-refresh: 2s</div>
      <div class="lang-toggle" role="group" aria-label="Language toggle">
        <button type="button" class="lang-btn" id="btnKo" onclick="setLang('ko')">한국어</button>
        <button type="button" class="lang-btn" id="btnEn" onclick="setLang('en')">EN</button>
      </div>
    </div>
  </header>
  <div class="container">
    <nav>
      <div class="card" style="position:sticky; top:16px;">
        <div class="card-title" id="sessionsSectionTitle">Sessions (.asd)</div>
        <div id="sessionList">Loading...</div>
      </div>
    </nav>
    <main>
      <div class="kpis" id="kpiGrid"></div>
      <div class="card" style="margin-bottom:16px;">
        <div class="card-title" id="debatesSectionTitle">Adversarial Debates in Selected Session</div>
        <div id="debateList">-</div>
      </div>
      <div class="card">
        <div class="card-title" id="tasksSectionTitle">Tasks & Wave Execution in Selected Session</div>
        <div id="taskList">Loading...</div>
      </div>
    </main>
    <aside>
      <div class="card" style="position:sticky; top:16px;">
        <div class="card-title" id="inspectorSectionTitle">Subagent Log & Prompt Inspector</div>
        <div id="inspector">-</div>
      </div>
    </aside>
  </div>
  <script>
    const SERVER_DEFAULT_LANG = "${defaultLang}";
    const I18N = {
      ko: {
        headerTitle: "ASD 멀티 에이전트 컨트롤 플레인 (v${ASD_VERSION})",
        updatedPrefix: "최근 갱신: ",
        sessionsSectionTitle: "세션 목록 (클릭하여 상세 보기 · 메모 관리)",
        noSessions: "기록된 세션이 없습니다.",
        memoPlaceholder: "(메모 없음)",
        editMemoBtn: "메모",
        editMemoPrompt: "이 세션의 짧은 메모를 입력하세요 (.asd 내부에 저장됩니다):",
        activeSession: "선택된 세션",
        noSession: "없음",
        phasePrefix: "단계: ",
        progress: "세션 작업 진행률",
        harnesses: "하네스 가용 상태",
        installedOk: "설치됨",
        installedNo: "미설치",
        tasksSectionTitle: "세션 내 작업(Task) 실행 현황 (클릭 시 우측에 서브에이전트 로그 표시)",
        noTasks: "선택된 세션에 등록된 작업이 없습니다.",
        debatesSectionTitle: "세션 내 적대적 토론 (클릭 시 해당 토론의 리뷰어 서브에이전트 로그 표시)",
        noDebates: "선택된 세션에 기록된 토론 내역이 없습니다.",
        inspectorSectionTitle: "서브에이전트 실행 로그 & 프롬프트 뷰어",
        noLogs: "선택된 항목의 서브에이전트 실행 로그가 없습니다",
        forTask: " — 대상: ",
        subSession: "서브세션",
        statusLabel: "상태",
        outputLog: "실행 출력 로그 (output.log)",
        promptLabel: "전달된 프롬프트 (prompt.md)",
        emptyText: "(비어 있음)",
        showAllSessionLogs: "이 세션의 전체 서브에이전트 보기",
        statusMap: {
          done: "완료",
          running: "실행중",
          failed: "실패",
          escalated: "상위모델 승격",
          merge_conflict: "병합 충돌",
          pending: "대기중"
        }
      },
      en: {
        headerTitle: "ASD Multi-Agent Control Plane (v${ASD_VERSION})",
        updatedPrefix: "Updated: ",
        sessionsSectionTitle: "Sessions (Click to inspect · Manage memos)",
        noSessions: "No sessions recorded.",
        memoPlaceholder: "(no memo)",
        editMemoBtn: "Memo",
        editMemoPrompt: "Enter a short memo for this session (saved in .asd):",
        activeSession: "Selected Session",
        noSession: "None",
        phasePrefix: "Phase: ",
        progress: "Session Task Progress",
        harnesses: "Harnesses",
        installedOk: "OK",
        installedNo: "N/A",
        tasksSectionTitle: "Session Tasks & Wave Execution (Click any task to inspect logs)",
        noTasks: "No tasks in selected session.",
        debatesSectionTitle: "Session Adversarial Debates (Click any debate to inspect reviewer logs)",
        noDebates: "No debates in selected session.",
        inspectorSectionTitle: "Subagent Log & Prompt Inspector",
        noLogs: "No subagent log found",
        forTask: " for ",
        subSession: "SubSession",
        statusLabel: "Status",
        outputLog: "Output Log",
        promptLabel: "Prompt",
        emptyText: "(empty)",
        showAllSessionLogs: "Show all subagents in this session",
        statusMap: {
          done: "done",
          running: "running",
          failed: "failed",
          escalated: "escalated",
          merge_conflict: "merge_conflict",
          pending: "pending"
        }
      }
    };

    function detectInitialLang() {
      try {
        const saved = localStorage.getItem("asd_lang");
        if (saved === "ko" || saved === "en") return saved;
      } catch {}
      const navLang = (navigator.language || SERVER_DEFAULT_LANG || "en").toLowerCase();
      return navLang.startsWith("ko") ? "ko" : "en";
    }

    let currentLang = detectInitialLang();
    let selectedSessionId = null;
    let selectedTaskId = null;
    let selectedSubSessionId = null;
    let latestState = null;

    function updateLangButtons() {
      document.documentElement.lang = currentLang;
      document.getElementById("btnKo").classList.toggle("active", currentLang === "ko");
      document.getElementById("btnEn").classList.toggle("active", currentLang === "en");
      const t = I18N[currentLang];
      document.getElementById("headerTitle").textContent = t.headerTitle;
      document.getElementById("sessionsSectionTitle").textContent = t.sessionsSectionTitle;
      document.getElementById("tasksSectionTitle").textContent = t.tasksSectionTitle;
      document.getElementById("debatesSectionTitle").textContent = t.debatesSectionTitle;
      document.getElementById("inspectorSectionTitle").textContent = t.inspectorSectionTitle;
    }

    function setLang(lang) {
      if (lang !== "ko" && lang !== "en") return;
      currentLang = lang;
      try { localStorage.setItem("asd_lang", lang); } catch {}
      updateLangButtons();
      render(latestState);
    }

    function esc(s) {
      return String(s ?? "")
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;")
        .replace(/'/g, "&#39;");
    }

    function selectSession(sessionId) {
      selectedSessionId = sessionId;
      selectedTaskId = null;
      selectedSubSessionId = null;
      render(latestState);
    }

    function selectTask(taskId) {
      selectedTaskId = taskId;
      selectedSubSessionId = null;
      render(latestState);
    }

    function selectSubSession(subSessionId) {
      selectedSubSessionId = subSessionId;
      render(latestState);
    }

    async function editSessionMemo(ev, sessionId, currentMemo) {
      ev.stopPropagation();
      const t = I18N[currentLang];
      const nextMemo = window.prompt(t.editMemoPrompt, currentMemo || "");
      if (nextMemo === null) return;
      try {
        const res = await fetch("/api/session-memo", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ sessionId, memo: nextMemo.trim() })
        });
        if (res.ok) {
          await poll();
        }
      } catch {}
    }

    function formatCreatedTime(ms) {
      if (!ms) return "-";
      const d = new Date(ms);
      return d.toLocaleString(currentLang === "ko" ? "ko-KR" : "en-US", {
        month: "2-digit",
        day: "2-digit",
        hour: "2-digit",
        minute: "2-digit",
        second: "2-digit"
      });
    }

    function render(data) {
      updateLangButtons();
      if (!data) return;
      latestState = data;
      const t = I18N[currentLang];

      document.getElementById("projPath").textContent = data.projectRoot;
      document.getElementById("lastUpdated").textContent =
        t.updatedPrefix + new Date(data.timestamp).toLocaleTimeString(currentLang === "ko" ? "ko-KR" : "en-US");

      const sessions = data.sessions || (data.session ? [data.session] : []);
      if (!selectedSessionId && sessions.length > 0) {
        selectedSessionId = sessions[0].session_id;
      }
      const activeSess = sessions.find(s => s.session_id === selectedSessionId) || sessions[0] || null;
      if (activeSess) {
        selectedSessionId = activeSess.session_id;
      }

      // 1. Render Left Session List (Main Session ID + Created Time + Short Memo)
      if (!sessions.length) {
        document.getElementById("sessionList").innerHTML =
          \`<div class="meta-bar">\${t.noSessions}</div>\`;
      } else {
        document.getElementById("sessionList").innerHTML = sessions.map(s => {
          const isSel = activeSess && s.session_id === activeSess.session_id;
          const createdStr = formatCreatedTime(s.created_at);
          const memoStr = (s.memo && s.memo.trim()) ? s.memo.trim() : "";
          return \`
            <div class="session-item \${isSel ? 'active' : ''}" onclick="selectSession('\${esc(s.session_id)}')">
              <div class="session-item-header">
                <span>\${esc(s.session_id)}</span>
              </div>
              <div class="meta-bar">\${esc(createdStr)}</div>
              <div class="session-memo-row">
                <span style="overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">\${memoStr ? esc(memoStr) : '<span class="meta-bar">' + esc(t.memoPlaceholder) + '</span>'}</span>
                <button type="button" class="memo-edit-btn" onclick="editSessionMemo(event, '\${esc(s.session_id)}', '\${esc(memoStr)}')">\${esc(t.editMemoBtn)}</button>
              </div>
            </div>
          \`;
        }).join("");
      }

      const allTasks = data.allTasks || data.tasks || [];
      const allDebates = data.allDebates || data.debates || [];
      const tasks = activeSess ? allTasks.filter(x => x.session_id === activeSess.session_id) : [];
      const debates = activeSess ? allDebates.filter(d => d.session_id === activeSess.session_id) : [];

      const done = tasks.filter(x => x.status === "done").length;
      const pct = tasks.length ? Math.round((done / tasks.length) * 100) : 0;

      const harnessBadges = Object.entries(data.harnesses || {})
        .map(([k, v]) => \`<span class="badge \${v.installed ? 'st-done' : 'st-pending'}">\${esc(k)}: \${v.installed ? t.installedOk : t.installedNo}</span>\`)
        .join("");

      document.getElementById("kpiGrid").innerHTML = \`
        <div class="card">
          <div class="card-title">\${t.activeSession}</div>
          <div class="card-value">\${activeSess ? esc(activeSess.session_id) : t.noSession}</div>
          <div class="meta-bar">\${activeSess && activeSess.memo ? esc(activeSess.memo) + ' · ' : ''}\${t.phasePrefix}\${activeSess ? esc(activeSess.phase) : "-"}</div>
        </div>
        <div class="card">
          <div class="card-title">\${t.progress}</div>
          <div class="card-value">\${done} / \${tasks.length} (\${pct}%)</div>
          <div class="progress-bar"><div class="progress-fill" style="width:\${pct}%"></div></div>
        </div>
        <div class="card">
          <div class="card-title">\${t.harnesses}</div>
          <div class="harness-list">\${harnessBadges}</div>
        </div>
      \`;

      // 2. Render Debates in Selected Session
      if (!debates.length) {
        document.getElementById("debateList").innerHTML =
          \`<div class="meta-bar">\${t.noDebates}</div>\`;
      } else {
        document.getElementById("debateList").innerHTML = debates.map(d => {
          let iv = null;
          try {
            if (d.insight_verdict_json) iv = JSON.parse(d.insight_verdict_json);
          } catch {}
          const verdictBadge = iv && iv.verdict
            ? \`<span class="badge \${iv.verdict === 'APPROVE' ? 'st-done' : iv.verdict === 'MINOR_AMEND' ? 'st-running' : 'st-failed'}">\${esc(iv.verdict)}</span>\`
            : "";
          const decisionsHtml = iv && Array.isArray(iv.decisions) && iv.decisions.length
            ? \`<div class="meta-bar" style="margin-top:6px;"><strong>Decisions:</strong><ul style="margin:4px 0 0 18px;padding:0;">\${iv.decisions.map(x => \`<li>\${esc(x)}</li>\`).join("")}</ul></div>\`
            : "";
          const constraintsHtml = iv && Array.isArray(iv.hard_constraints) && iv.hard_constraints.length
            ? \`<div class="meta-bar" style="margin-top:6px;"><strong>Hard Constraints:</strong><ul style="margin:4px 0 0 18px;padding:0;">\${iv.hard_constraints.map(x => \`<li>\${esc(x)}</li>\`).join("")}</ul></div>\`
            : "";
          const risksHtml = iv && Array.isArray(iv.risks) && iv.risks.length
            ? \`<div class="meta-bar" style="margin-top:6px;"><strong>Risks:</strong><ul style="margin:4px 0 0 18px;padding:0;">\${iv.risks.map(x => \`<li>\${esc(x)}</li>\`).join("")}</ul></div>\`
            : "";
          const targetLogKey = d.task_id || d.debate_id;
          const isSel = selectedTaskId === targetLogKey || selectedTaskId === d.debate_id;
          return \`
            <div class="debate-row \${isSel ? 'active' : ''}" onclick="selectTask('\${esc(d.debate_id)}')">
              <div>
                <strong>\${esc(d.debate_id)}</strong> — \${esc(d.topic)}
                <span class="badge st-\${d.status === 'done' ? 'done' : 'running'}">\${esc(d.status)}</span>
                \${verdictBadge}
              </div>
              \${decisionsHtml}
              \${constraintsHtml}
              \${risksHtml}
            </div>
          \`;
        }).join("");
      }

      // 3. Render Tasks in Selected Session
      if (!tasks.length) {
        document.getElementById("taskList").innerHTML =
          \`<div class="meta-bar">\${t.noTasks}</div>\`;
      } else {
        document.getElementById("taskList").innerHTML = tasks.map(item => {
          const isSel = selectedTaskId === item.task_id;
          const modelTag = (item.assigned_harness || "-") + "/" + (item.assigned_model || "pending");
          const dur = item.duration_ms ? (item.duration_ms / 1000).toFixed(1) + "s" : "";
          const statusText = t.statusMap[item.status] || item.status;
          return \`
            <div class="task-row \${isSel ? 'active' : ''}" onclick="selectTask('\${esc(item.task_id)}')">
              <div>
                <span class="badge st-\${esc(item.status)}">\${esc(statusText)}</span>
                <strong>\${esc(item.task_id)}</strong>
                <span class="meta-bar">[Turn \${item.turn} | \${esc(item.track)} | \${esc(item.role)}]</span>
                <div>\${esc(item.title)}</div>
              </div>
              <div style="text-align:right" class="meta-bar">
                <div>\${esc(modelTag)}</div>
                <div>\${esc(dur)} \${item.commit_sha ? '(' + esc(item.commit_sha.slice(0,7)) + ')' : ''}</div>
              </div>
            </div>
          \`;
        }).join("");
      }

      // 4. Render Subagents in Selected Session (filtered by selected Debate/Task if any)
      const allLogs = data.subagentLogs || [];
      const sessionLogs = activeSess
        ? allLogs.filter(l => l.sessionId === activeSess.session_id)
        : allLogs;

      const filteredLogs = selectedTaskId
        ? sessionLogs.filter(l =>
            l.taskId.toUpperCase() === selectedTaskId.toUpperCase() ||
            l.subSessionId.toUpperCase().includes(selectedTaskId.toUpperCase())
          )
        : sessionLogs;

      const effectiveLogs = filteredLogs.length > 0 ? filteredLogs : sessionLogs;

      const activeLog = selectedSubSessionId
        ? effectiveLogs.find(l => l.subSessionId === selectedSubSessionId) || effectiveLogs[0]
        : effectiveLogs[0];

      if (!activeLog) {
        document.getElementById("inspector").innerHTML =
          \`<div class="meta-bar">\${t.noLogs}\${selectedTaskId ? t.forTask + esc(selectedTaskId) : ''}.</div>\`;
      } else {
        const statusText = t.statusMap[activeLog.status] || activeLog.status;
        const resetFilterBtn = selectedTaskId
          ? \`<div style="margin-bottom:6px;"><button type="button" class="memo-edit-btn" onclick="selectTask(null)">\${esc(t.showAllSessionLogs)} (\${sessionLogs.length})</button></div>\`
          : "";
        const logPills = effectiveLogs.map(l => {
          const isCur = l.subSessionId === activeLog.subSessionId;
          const shortSub = l.subSessionId.replace(l.sessionId + "-", "");
          const label = (l.role || l.taskId || "sub") + " [" + shortSub + "] @" + l.harness;
          return \`<span class="badge \${isCur ? 'st-running' : 'st-pending'}" style="cursor:pointer;" onclick="selectSubSession('\${esc(l.subSessionId)}')">\${esc(label)}</span>\`;
        }).join("");
        document.getElementById("inspector").innerHTML = \`
          \${resetFilterBtn}
          <div class="pill-scroll">\${logPills}</div>
          <div><strong>\${esc(activeLog.taskId || activeLog.role || activeLog.subSessionId)}</strong> — \${esc(activeLog.harness)} (\${esc(activeLog.model)}) | <span class="meta-bar">Role: \${esc(activeLog.role)}</span></div>
          <div class="meta-bar">\${t.subSession}: \${esc(activeLog.subSessionId)} | \${t.statusLabel}: \${esc(statusText)}</div>
          <div class="card-title" style="margin-top:10px;">\${t.outputLog}</div>
          <pre>\${esc(activeLog.outputLog || t.emptyText)}</pre>
          <div class="card-title" style="margin-top:10px;">\${t.promptLabel}</div>
          <pre>\${esc(activeLog.prompt || t.emptyText)}</pre>
        \`;
      }
    }

    updateLangButtons();
    async function poll() {
      try {
        const res = await fetch("/api/state");
        if (res.ok) render(await res.json());
      } catch {}
    }
    poll();
    setInterval(poll, 2000);
  </script>
</body>
</html>`;
}

export interface DashboardServerHandle {
  server: http.Server;
  url: string;
  port: number;
  close: () => Promise<void>;
}

function readRequestBody(req: http.IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let body = "";
    req.on("data", (chunk) => {
      body += String(chunk);
      if (body.length > 64 * 1024) {
        reject(new Error("Payload too large"));
      }
    });
    req.on("end", () => resolve(body));
    req.on("error", reject);
  });
}

export async function startDashboardServer(options?: {
  port?: number;
  host?: string;
  projectRoot?: string;
  homeDir?: string;
}): Promise<DashboardServerHandle> {
  const host = options?.host || "127.0.0.1";
  const requestedPort = options?.port ?? 3847;
  const projectRoot = path.resolve(options?.projectRoot || process.cwd());
  const homeDir = options?.homeDir;

  const server = http.createServer(async (req, res) => {
    try {
      const urlObj = new URL(req.url || "/", `http://${host}`);
      if (req.method === "GET" && urlObj.pathname === "/api/state") {
        const snapshot = await collectDashboardSnapshot({ projectRoot, homeDir });
        const body = JSON.stringify(snapshot);
        res.writeHead(200, {
          "Content-Type": "application/json; charset=utf-8",
          "Cache-Control": "no-store",
        });
        res.end(body);
        return;
      }

      if (req.method === "POST" && urlObj.pathname === "/api/session-memo") {
        const rawBody = await readRequestBody(req);
        const parsed = JSON.parse(rawBody || "{}") as { sessionId?: string; memo?: string };
        if (!parsed.sessionId) {
          res.writeHead(400, { "Content-Type": "application/json; charset=utf-8" });
          res.end(JSON.stringify({ error: "Missing sessionId" }));
          return;
        }
        const saved = saveSessionMemo({
          projectRoot,
          homeDir,
          sessionId: parsed.sessionId,
          memo: String(parsed.memo ?? ""),
        });
        res.writeHead(200, {
          "Content-Type": "application/json; charset=utf-8",
          "Cache-Control": "no-store",
        });
        res.end(JSON.stringify(saved));
        return;
      }

      if (req.method === "GET" && (urlObj.pathname === "/" || urlObj.pathname === "/index.html")) {
        const html = renderDashboardHtml();
        res.writeHead(200, {
          "Content-Type": "text/html; charset=utf-8",
          "Cache-Control": "no-store",
        });
        res.end(html);
        return;
      }

      res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
      res.end("Not Found");
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      res.writeHead(500, { "Content-Type": "application/json; charset=utf-8" });
      res.end(JSON.stringify({ error: msg }));
    }
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(requestedPort, host, () => resolve());
  });

  const addr = server.address();
  const actualPort = typeof addr === "object" && addr ? addr.port : requestedPort;
  const url = `http://${host}:${actualPort}`;

  return {
    server,
    url,
    port: actualPort,
    close: () =>
      new Promise<void>((resolve) => {
        server.close(() => resolve());
      }),
  };
}
