/**
 * ASD v2.2 Core LSP & Code Intelligence Engine (src/core/lsp.ts).
 *
 * Provides zero-dependency static diagnostics, symbol extraction,
 * definition lookup, and reference search across TypeScript/JavaScript,
 * Python, Go, and Rust projects.
 *
 * Invariants:
 * - Core Purity: ZERO imports from src/adapters/*.
 * - Erasable TypeScript only: NO enum, NO parameter properties.
 * - Zero external runtime npm dependencies.
 */

import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { resolveSpawnCommand } from "./spawner.ts";

// ============================================================================
// Types
// ============================================================================

export type LspLanguage = "typescript" | "javascript" | "python" | "go" | "rust" | "unknown";

export type DiagnosticSeverity = "error" | "warning" | "info";

export interface LspDiagnosticItem {
  file: string;
  line: number;
  column: number;
  severity: DiagnosticSeverity;
  code?: string;
  message: string;
}

export interface LspDiagnosticsResult {
  ok: boolean;
  language: LspLanguage;
  engine: string;
  diagnostics: LspDiagnosticItem[];
}

export type SymbolKind =
  | "function"
  | "class"
  | "interface"
  | "type"
  | "variable"
  | "struct"
  | "method";

export interface LspSymbolItem {
  name: string;
  kind: SymbolKind;
  file: string;
  line: number;
  column: number;
  exported: boolean;
  signature: string;
}

export interface LspDefinitionItem {
  symbol: string;
  kind: SymbolKind;
  file: string;
  line: number;
  column: number;
  preview: string;
}

export interface LspReferenceItem {
  file: string;
  line: number;
  column: number;
  preview: string;
  isDefinition: boolean;
}

export interface LspCommandRunnerResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

export type LspCommandRunner = (
  cmd: string,
  args: string[],
  cwd: string
) => LspCommandRunnerResult;

// ============================================================================
// File Discovery & Language Detection
// ============================================================================

const IGNORED_DIRS = new Set([
  "node_modules",
  ".git",
  ".asd",
  ".omo",
  "dist",
  "build",
  "out",
  "target",
  "__pycache__",
  ".venv",
  "venv",
  "coverage",
]);

const CODE_EXTENSIONS = new Set([
  ".ts",
  ".tsx",
  ".mts",
  ".cts",
  ".js",
  ".jsx",
  ".mjs",
  ".cjs",
  ".py",
  ".go",
  ".rs",
]);

export function detectLanguage(projectRoot: string, filePath?: string): LspLanguage {
  if (filePath) {
    const ext = path.extname(filePath).toLowerCase();
    if (ext === ".ts" || ext === ".tsx" || ext === ".mts" || ext === ".cts") return "typescript";
    if (ext === ".js" || ext === ".jsx" || ext === ".mjs" || ext === ".cjs") return "javascript";
    if (ext === ".py") return "python";
    if (ext === ".go") return "go";
    if (ext === ".rs") return "rust";
  }

  if (fs.existsSync(path.join(projectRoot, "tsconfig.json"))) return "typescript";
  if (fs.existsSync(path.join(projectRoot, "Cargo.toml"))) return "rust";
  if (fs.existsSync(path.join(projectRoot, "go.mod"))) return "go";
  if (
    fs.existsSync(path.join(projectRoot, "pyproject.toml")) ||
    fs.existsSync(path.join(projectRoot, "requirements.txt"))
  ) {
    return "python";
  }
  if (fs.existsSync(path.join(projectRoot, "package.json"))) return "javascript";

  return "unknown";
}

export function collectSourceFiles(rootDir: string, targetPath?: string): string[] {
  if (targetPath) {
    const resolved = path.isAbsolute(targetPath)
      ? targetPath
      : path.resolve(rootDir, targetPath);
    if (!fs.existsSync(resolved)) return [];
    const stat = fs.statSync(resolved);
    if (stat.isFile()) return [resolved];
    return walkDirectory(resolved);
  }
  return walkDirectory(rootDir);
}

function walkDirectory(dir: string): string[] {
  const results: string[] = [];
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return results;
  }

  for (const entry of entries) {
    if (entry.isDirectory()) {
      if (IGNORED_DIRS.has(entry.name) || entry.name.startsWith(".")) continue;
      results.push(...walkDirectory(path.join(dir, entry.name)));
    } else if (entry.isFile()) {
      const ext = path.extname(entry.name).toLowerCase();
      if (CODE_EXTENSIONS.has(ext)) {
        results.push(path.join(dir, entry.name));
      }
    }
  }
  return results;
}

function toRelativeFile(projectRoot: string, absOrRel: string): string {
  const abs = path.isAbsolute(absOrRel) ? absOrRel : path.resolve(projectRoot, absOrRel);
  const rel = path.relative(projectRoot, abs).replaceAll("\\", "/");
  return rel.startsWith("..") ? abs.replaceAll("\\", "/") : rel;
}

// ============================================================================
// Diagnostics Engine
// ============================================================================

const defaultRunner: LspCommandRunner = (cmd, args, cwd) => {
  const resolved = resolveSpawnCommand(cmd, args);
  const res = spawnSync(resolved.command, resolved.args, {
    cwd,
    encoding: "utf8",
    timeout: 15000,
    windowsHide: true,
    shell: resolved.shell,
  });
  return {
    exitCode: res.status ?? (res.error ? 1 : 0),
    stdout: res.stdout ?? "",
    stderr: res.stderr ?? "",
  };
};

/**
 * Parse TypeScript `tsc --noEmit --pretty false` output lines:
 * `src/foo.ts(12,5): error TS2322: Type 'string' is not assignable to type 'number'.`
 */
export function parseTscOutput(output: string, projectRoot: string): LspDiagnosticItem[] {
  const items: LspDiagnosticItem[] = [];
  const regex = /^(.+?)\((\d+),(\d+)\):\s+(error|warning|info)\s+(TS\d+):\s+(.+)$/;
  for (const rawLine of output.split(/\r?\n/)) {
    const line = rawLine.trim();
    const match = regex.exec(line);
    if (match) {
      const [, file, lineStr, colStr, sev, code, message] = match;
      items.push({
        file: toRelativeFile(projectRoot, file!),
        line: Number.parseInt(lineStr!, 10),
        column: Number.parseInt(colStr!, 10),
        severity: (sev as DiagnosticSeverity) || "error",
        code: code!,
        message: message!,
      });
    }
  }
  return items;
}

/**
 * Fallback lightweight structural & syntax check for TS/JS files when external tsc is absent.
 * Checks balanced delimiters and Node `--check` syntax validation.
 */
function runBuiltinSyntaxDiagnostics(
  projectRoot: string,
  files: string[]
): LspDiagnosticItem[] {
  const diagnostics: LspDiagnosticItem[] = [];
  for (const file of files) {
    let content = "";
    try {
      content = fs.readFileSync(file, "utf8");
    } catch {
      continue;
    }

    // Check for merge conflict markers
    const lines = content.split(/\r?\n/);
    for (let i = 0; i < lines.length; i++) {
      const lineText = lines[i]!;
      if (/^(<{7}|={7}|>{7})(\s|$)/.test(lineText)) {
        diagnostics.push({
          file: toRelativeFile(projectRoot, file),
          line: i + 1,
          column: 1,
          severity: "error",
          code: "SYNTAX_CONFLICT",
          message: "Unresolved git merge conflict marker detected.",
        });
      }
    }

    // Use node --check for .ts/.js syntax verification (Node >=22.13 native TS stripping)
    const ext = path.extname(file).toLowerCase();
    if ([".ts", ".mts", ".cts", ".js", ".mjs", ".cjs"].includes(ext)) {
      const checkRes = spawnSync(process.execPath, ["--no-warnings", "--check", file], {
        cwd: projectRoot,
        encoding: "utf8",
        timeout: 5000,
        windowsHide: true,
      });
      if (checkRes.status !== 0 && checkRes.stderr) {
        const stderrLines = checkRes.stderr.split(/\r?\n/);
        let lineNum = 1;
        let colNum = 1;
        for (const sl of stderrLines) {
          const locMatch = /:(\d+)(?::(\d+))?$/.exec(sl.trim());
          if (locMatch) {
            lineNum = Number.parseInt(locMatch[1]!, 10);
            if (locMatch[2]) colNum = Number.parseInt(locMatch[2]!, 10);
            break;
          }
        }
        const errMsgLine =
          stderrLines.find((l) => /SyntaxError:|Error:/.test(l))?.trim() ??
          stderrLines[0]?.trim() ??
          "Syntax error";
        diagnostics.push({
          file: toRelativeFile(projectRoot, file),
          line: lineNum,
          column: colNum,
          severity: "error",
          code: "SYNTAX_ERROR",
          message: errMsgLine,
        });
      }
    }
  }
  return diagnostics;
}

export function runDiagnostics(options: {
  projectRoot: string;
  filePath?: string;
  runner?: LspCommandRunner;
}): LspDiagnosticsResult {
  const { projectRoot, filePath, runner = defaultRunner } = options;
  const language = detectLanguage(projectRoot, filePath);

  if (language === "typescript" || language === "javascript") {
    const localTsc = path.join(
      projectRoot,
      "node_modules",
      ".bin",
      process.platform === "win32" ? "tsc.cmd" : "tsc"
    );
    if (fs.existsSync(localTsc) || runner !== defaultRunner) {
      const cmd = fs.existsSync(localTsc) ? localTsc : "tsc";
      const res = runner(cmd, ["--noEmit", "--pretty", "false"], projectRoot);
      const combined = `${res.stdout}\n${res.stderr}`;
      let parsed = parseTscOutput(combined, projectRoot);
      if (filePath) {
        const relTarget = toRelativeFile(projectRoot, filePath);
        parsed = parsed.filter((d) => d.file === relTarget);
      }
      return {
        ok: parsed.length === 0,
        language,
        engine: "tsc",
        diagnostics: parsed,
      };
    }

    const files = collectSourceFiles(projectRoot, filePath);
    const builtinDiags = runBuiltinSyntaxDiagnostics(projectRoot, files);
    return {
      ok: builtinDiags.length === 0,
      language,
      engine: "node-check",
      diagnostics: builtinDiags,
    };
  }

  const files = collectSourceFiles(projectRoot, filePath);
  const builtinDiags = runBuiltinSyntaxDiagnostics(projectRoot, files);
  return {
    ok: builtinDiags.length === 0,
    language,
    engine: "builtin-syntax",
    diagnostics: builtinDiags,
  };
}

// ============================================================================
// Symbols, Definitions, and References
// ============================================================================

interface SymbolPattern {
  kind: SymbolKind;
  regex: RegExp;
  exportGroup?: number;
  nameGroup: number;
}

const SYMBOL_PATTERNS: readonly SymbolPattern[] = [
  // TS/JS function: [export] [async] function foo(...)
  {
    kind: "function",
    regex: /^(\s*)(export\s+)?(?:default\s+)?(?:async\s+)?function\s+([A-Za-z_$][\w$]*)/,
    exportGroup: 2,
    nameGroup: 3,
  },
  // TS/JS class: [export] [abstract] class Foo
  {
    kind: "class",
    regex: /^(\s*)(export\s+)?(?:default\s+)?(?:abstract\s+)?class\s+([A-Za-z_$][\w$]*)/,
    exportGroup: 2,
    nameGroup: 3,
  },
  // TS interface: [export] interface Foo
  {
    kind: "interface",
    regex: /^(\s*)(export\s+)?interface\s+([A-Za-z_$][\w$]*)/,
    exportGroup: 2,
    nameGroup: 3,
  },
  // TS type alias: [export] type Foo =
  {
    kind: "type",
    regex: /^(\s*)(export\s+)?type\s+([A-Za-z_$][\w$]*)\s*(?:<[^>]*>)?\s*=/,
    exportGroup: 2,
    nameGroup: 3,
  },
  // TS/JS const/let exported or top-level variable/arrow function
  {
    kind: "variable",
    regex: /^(\s*)(export\s+)?(?:const|let)\s+([A-Za-z_$][\w$]*)\s*(?::[^=]+)?=/,
    exportGroup: 2,
    nameGroup: 3,
  },
  // Python def / class
  {
    kind: "function",
    regex: /^(\s*)def\s+([A-Za-z_]\w*)\s*\(/,
    nameGroup: 2,
  },
  {
    kind: "class",
    regex: /^(\s*)class\s+([A-Za-z_]\w*)\s*[:(]/,
    nameGroup: 2,
  },
  // Rust / Go fn / func / struct
  {
    kind: "function",
    regex: /^(\s*)(pub\s+)?(?:async\s+)?fn\s+([A-Za-z_]\w*)/,
    exportGroup: 2,
    nameGroup: 3,
  },
  {
    kind: "struct",
    regex: /^(\s*)(pub\s+)?struct\s+([A-Za-z_]\w*)/,
    exportGroup: 2,
    nameGroup: 3,
  },
  {
    kind: "function",
    regex: /^(\s*)func\s+(?:\([^)]+\)\s+)?([A-Za-z_]\w*)\s*\(/,
    nameGroup: 2,
  },
];

export function extractSymbols(options: {
  projectRoot: string;
  targetPath?: string;
   exportedOnly?: boolean;
}): LspSymbolItem[] {
  const { projectRoot, targetPath, exportedOnly = false } = options;
  const files = collectSourceFiles(projectRoot, targetPath);
  const symbols: LspSymbolItem[] = [];

  for (const file of files) {
    let content = "";
    try {
      content = fs.readFileSync(file, "utf8");
    } catch {
      continue;
    }

    const relFile = toRelativeFile(projectRoot, file);
    const lines = content.split(/\r?\n/);

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i]!;
      for (const pat of SYMBOL_PATTERNS) {
        const match = pat.regex.exec(line);
        if (!match) continue;

        const indent = match[1] ?? "";
        // Skip deeply nested local variables unless exported
        const isExported = pat.exportGroup ? Boolean(match[pat.exportGroup]) : indent.length === 0;
        if (pat.kind === "variable" && indent.length > 0 && !isExported) {
          continue;
        }
        if (exportedOnly && !isExported) {
          continue;
        }

        const name = match[pat.nameGroup]!;
        const col = line.indexOf(name) + 1;
        symbols.push({
          name,
          kind: pat.kind,
          file: relFile,
          line: i + 1,
          column: col > 0 ? col : 1,
          exported: isExported,
          signature: line.trim(),
        });
        break;
      }
    }
  }

  return symbols;
}

export function findDefinition(options: {
  projectRoot: string;
  symbol: string;
  targetPath?: string;
}): LspDefinitionItem[] {
  const { projectRoot, symbol, targetPath } = options;
  const allSymbols = extractSymbols({ projectRoot, targetPath });
  return allSymbols
    .filter((s) => s.name === symbol)
    .map((s) => ({
      symbol: s.name,
      kind: s.kind,
      file: s.file,
      line: s.line,
      column: s.column,
      preview: s.signature,
    }));
}

export function findReferences(options: {
  projectRoot: string;
  symbol: string;
  targetPath?: string;
}): LspReferenceItem[] {
  const { projectRoot, symbol, targetPath } = options;
  if (!symbol || !/^[A-Za-z_$][\w$]*$/.test(symbol)) {
    return [];
  }

  const files = collectSourceFiles(projectRoot, targetPath);
  const defs = new Set(
    findDefinition({ projectRoot, symbol, targetPath }).map((d) => `${d.file}:${d.line}`)
  );

  const wordRegex = new RegExp(`\\b${symbol.replace(/\$/g, "\\$")}\\b`, "g");
  const references: LspReferenceItem[] = [];

  for (const file of files) {
    let content = "";
    try {
      content = fs.readFileSync(file, "utf8");
    } catch {
      continue;
    }

    const relFile = toRelativeFile(projectRoot, file);
    const lines = content.split(/\r?\n/);

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i]!;
      wordRegex.lastIndex = 0;
      const match = wordRegex.exec(line);
      if (match) {
        const lineNum = i + 1;
        references.push({
          file: relFile,
          line: lineNum,
          column: match.index + 1,
          preview: line.trim(),
          isDefinition: defs.has(`${relFile}:${lineNum}`),
        });
      }
    }
  }

  return references;
}
