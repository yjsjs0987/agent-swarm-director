/**
 * ASD v2.2 Lightweight Zero-Dependency Web Dashboard (src/cli/dashboard.ts)
 *
 * Uses built-in `node:http` with zero external runtime dependencies.
 * Provides:
 * - `GET /api/state`: Live JSON snapshot of SQLite session, tasks, debates,
 *   subagent logs, and harness availability.
 * - `GET /`: Interactive dark-mode Web UI with auto-refresh, Turn/Wave task
 *   progress cards, click-to-inspect subagent prompt & log viewer, and
 *   adversarial debate verdict inspector.
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
import { ASD_VERSION } from "../core/types.ts";
import { type SubagentLogRecord } from "./index.ts";

export interface DashboardSnapshot {
  version: string;
  projectRoot: string;
  timestamp: number;
  session: SessionRow | null;
  tasks: TaskRow[];
  debates: DebateRow[];
  subagentLogs: SubagentLogRecord[];
  harnesses: Record<
    string,
    { installed: boolean; headlessSupported: boolean; binary?: string; resolvedPath?: string | null }
  >;
}

function collectAllSubagentLogs(projectRoot: string): SubagentLogRecord[] {
  const sessionsRoot = path.join(projectRoot, ".asd", "sessions");
  if (!fs.existsSync(sessionsRoot)) return [];

  const records: SubagentLogRecord[] = [];
  try {
    const sessionDirs = fs.readdirSync(sessionsRoot, { withFileTypes: true });
    for (const sDir of sessionDirs) {
      if (!sDir.isDirectory()) continue;
      const subagentsDir = path.join(sessionsRoot, sDir.name, "subagents");
      if (!fs.existsSync(subagentsDir)) continue;

      const subDirs = fs.readdirSync(subagentsDir, { withFileTypes: true });
      for (const subDir of subDirs) {
        if (!subDir.isDirectory()) continue;
        const dirPath = path.join(subagentsDir, subDir.name);
        const metaPath = path.join(dirPath, "meta.json");
        if (!fs.existsSync(metaPath)) continue;

        try {
          const meta = JSON.parse(fs.readFileSync(metaPath, "utf8")) as Record<string, unknown>;
          const promptPath = path.join(dirPath, "prompt.md");
          const outputPath = path.join(dirPath, "output.log");
          records.push({
            sessionId: String(meta.mainSessionId ?? sDir.name),
            subSessionId: String(meta.subSessionId ?? subDir.name),
            taskId: String(meta.taskId ?? ""),
            role: String(meta.role ?? ""),
            harness: String(meta.harness ?? ""),
            model: String(meta.model ?? ""),
            status: String(meta.status ?? "unknown"),
            startedAt: Number(meta.startedAt ?? 0),
            finishedAt: typeof meta.finishedAt === "number" ? meta.finishedAt : undefined,
            prompt: fs.existsSync(promptPath) ? fs.readFileSync(promptPath, "utf8") : "",
            outputLog: fs.existsSync(outputPath) ? fs.readFileSync(outputPath, "utf8") : "",
            dirPath,
          });
        } catch {
          // Ignore malformed entry
        }
      }
    }
  } catch {
    return [];
  }

  records.sort((a, b) => b.startedAt - a.startedAt);
  return records;
}

export async function collectDashboardSnapshot(options?: {
  projectRoot?: string;
  homeDir?: string;
}): Promise<DashboardSnapshot> {
  const projectRoot = path.resolve(options?.projectRoot || process.cwd());
  const homeDir = options?.homeDir;
  const paths = resolveAsdPaths(projectRoot, homeDir);

  let session: SessionRow | null = null;
  let tasks: TaskRow[] = [];
  let debates: DebateRow[] = [];

  if (fs.existsSync(paths.dbPath)) {
    let db: SqliteDriver | undefined;
    try {
      db = openProjectDb(projectRoot, homeDir);
      session = db.getLatestSession() ?? null;
      if (session) {
        tasks = db.getSessionTasks(session.session_id);
        debates = db.getSessionDebates(session.session_id);
      }
    } catch {
      // Ignore transient read issues
    } finally {
      db?.close();
    }
  }

  const subagentLogs = collectAllSubagentLogs(projectRoot);
  const doctor = await runAsdDoctor({ projectRoot, homeDir });

  return {
    version: ASD_VERSION,
    projectRoot,
    timestamp: Date.now(),
    session,
    tasks,
    debates,
    subagentLogs,
    harnesses: doctor.harnesses,
  };
}

function renderDashboardHtml(): string {
  return `<!DOCTYPE html>
<html lang="ko">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>ASD v${ASD_VERSION} — Multi-Agent Dashboard</title>
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
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, monospace;
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
    .meta-bar { font-size: 12px; color: var(--muted); }
    .container {
      display: grid;
      grid-template-columns: 1fr 440px;
      gap: 16px;
      padding: 20px 24px;
      max-width: 1600px;
      margin: 0 auto;
    }
    @media (max-width: 1024px) {
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
    .card-title { font-size: 12px; color: var(--muted); text-transform: uppercase; margin-bottom: 6px; }
    .card-value { font-size: 20px; font-weight: 700; }
    .progress-bar {
      height: 8px;
      background: #1c273d;
      border-radius: 4px;
      overflow: hidden;
      margin-top: 8px;
    }
    .progress-fill { height: 100%; background: var(--ok); transition: width 0.25s ease; }
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
      max-height: 420px;
      white-space: pre-wrap;
      word-break: break-word;
    }
    .harness-list { display: flex; gap: 8px; flex-wrap: wrap; margin-top: 6px; }
  </style>
</head>
<body>
  <header>
    <div>
      <h1>ASD Multi-Agent Control Plane (v${ASD_VERSION})</h1>
      <div class="meta-bar" id="projPath">Loading...</div>
    </div>
    <div class="meta-bar" id="lastUpdated">Auto-refresh: 2s</div>
  </header>
  <div class="container">
    <main>
      <div class="kpis" id="kpiGrid"></div>
      <div class="card" style="margin-bottom:16px;">
        <div class="card-title">Tasks & Wave Execution (Click any task to inspect logs)</div>
        <div id="taskList">Loading...</div>
      </div>
      <div class="card">
        <div class="card-title">Adversarial Debates (asd_debate)</div>
        <div id="debateList">No debates recorded.</div>
      </div>
    </main>
    <aside>
      <div class="card" style="position:sticky; top:16px;">
        <div class="card-title">Subagent Log & Prompt Inspector</div>
        <div id="inspector">Click a task on the left or view the latest subagent run below.</div>
      </div>
    </aside>
  </div>
  <script>
    let selectedTaskId = null;
    let latestState = null;

    function esc(s) {
      return String(s ?? "")
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;");
    }

    function selectTask(taskId) {
      selectedTaskId = taskId;
      render(latestState);
    }

    function render(data) {
      if (!data) return;
      latestState = data;
      document.getElementById("projPath").textContent = data.projectRoot;
      document.getElementById("lastUpdated").textContent =
        "Updated: " + new Date(data.timestamp).toLocaleTimeString();

      const tasks = data.tasks || [];
      const done = tasks.filter(t => t.status === "done").length;
      const pct = tasks.length ? Math.round((done / tasks.length) * 100) : 0;
      const sess = data.session;

      const harnessBadges = Object.entries(data.harnesses || {})
        .map(([k, v]) => \`<span class="badge \${v.installed ? 'st-done' : 'st-pending'}">\${esc(k)}: \${v.installed ? 'OK' : 'N/A'}</span>\`)
        .join("");

      document.getElementById("kpiGrid").innerHTML = \`
        <div class="card">
          <div class="card-title">Active Session</div>
          <div class="card-value">\${sess ? esc(sess.session_id) : "None"}</div>
          <div class="meta-bar">Phase: \${sess ? esc(sess.phase) : "-"}</div>
        </div>
        <div class="card">
          <div class="card-title">Progress</div>
          <div class="card-value">\${done} / \${tasks.length} (\${pct}%)</div>
          <div class="progress-bar"><div class="progress-fill" style="width:\${pct}%"></div></div>
        </div>
        <div class="card">
          <div class="card-title">Harnesses</div>
          <div class="harness-list">\${harnessBadges}</div>
        </div>
      \`;

      if (!tasks.length) {
        document.getElementById("taskList").innerHTML =
          '<div class="meta-bar">No tasks in current session.</div>';
      } else {
        document.getElementById("taskList").innerHTML = tasks.map(t => {
          const isSel = selectedTaskId === t.task_id;
          const modelTag = (t.assigned_harness || "-") + "/" + (t.assigned_model || "pending");
          const dur = t.duration_ms ? (t.duration_ms / 1000).toFixed(1) + "s" : "";
          return \`
            <div class="task-row \${isSel ? 'active' : ''}" onclick="selectTask('\${esc(t.task_id)}')">
              <div>
                <span class="badge st-\${esc(t.status)}">\${esc(t.status)}</span>
                <strong>\${esc(t.task_id)}</strong>
                <span class="meta-bar">[Turn \${t.turn} | \${esc(t.track)} | \${esc(t.role)}]</span>
                <div>\${esc(t.title)}</div>
              </div>
              <div style="text-align:right" class="meta-bar">
                <div>\${esc(modelTag)}</div>
                <div>\${esc(dur)} \${t.commit_sha ? '(' + esc(t.commit_sha.slice(0,7)) + ')' : ''}</div>
              </div>
            </div>
          \`;
        }).join("");
      }

      const debates = data.debates || [];
      if (!debates.length) {
        document.getElementById("debateList").innerHTML =
          '<div class="meta-bar">No debates recorded.</div>';
      } else {
        document.getElementById("debateList").innerHTML = debates.map(d => \`
          <div style="border-bottom:1px solid var(--border); padding:8px 0;">
            <strong>\${esc(d.debate_id)}</strong> — \${esc(d.topic)}
            <span class="badge st-running">\${esc(d.status)}</span>
          </div>
        \`).join("");
      }

      const logs = data.subagentLogs || [];
      const activeLog = selectedTaskId
        ? logs.find(l => l.taskId.toUpperCase() === selectedTaskId.toUpperCase())
        : logs[0];

      if (!activeLog) {
        document.getElementById("inspector").innerHTML =
          '<div class="meta-bar">No subagent log found' + (selectedTaskId ? ' for ' + esc(selectedTaskId) : '') + '.</div>';
      } else {
        document.getElementById("inspector").innerHTML = \`
          <div><strong>\${esc(activeLog.taskId)}</strong> — \${esc(activeLog.harness)} (\${esc(activeLog.model)})</div>
          <div class="meta-bar">SubSession: \${esc(activeLog.subSessionId)} | Status: \${esc(activeLog.status)}</div>
          <div class="card-title" style="margin-top:10px;">Output Log</div>
          <pre>\${esc(activeLog.outputLog || "(empty)")}</pre>
          <div class="card-title" style="margin-top:10px;">Prompt</div>
          <pre>\${esc(activeLog.prompt || "(empty)")}</pre>
        \`;
      }
    }

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
      if (urlObj.pathname === "/api/state") {
        const snapshot = await collectDashboardSnapshot({ projectRoot, homeDir });
        const body = JSON.stringify(snapshot);
        res.writeHead(200, {
          "Content-Type": "application/json; charset=utf-8",
          "Cache-Control": "no-store",
        });
        res.end(body);
        return;
      }

      if (urlObj.pathname === "/" || urlObj.pathname === "/index.html") {
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
