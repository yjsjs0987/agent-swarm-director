/**
 * ASD v2.2 Standalone Built-in LSP MCP Server (src/mcp/lsp-server.ts).
 *
 * Separate from asd-core so that harnesses with native LSP (like OpenCode)
 * do not receive duplicate LSP tool schemas, while harnesses lacking native
 * CLI LSP receive full code intelligence (`lsp_diagnostics`, `lsp_symbols`,
 * `lsp_definition`, `lsp_references`).
 */

import type { Readable, Writable } from "node:stream";
import { fileURLToPath } from "node:url";
import {
  extractSymbols,
  findDefinition,
  findReferences,
  type LspCommandRunner,
  runDiagnostics,
} from "../core/lsp.ts";
import { StdioRpcServer } from "./stdio-rpc.ts";

export const ASD_LSP_MCP_TOOLS = [
  {
    name: "lsp_diagnostics",
    description:
      "Run static type/syntax diagnostics on a project or specific file and return structured errors and warnings.",
    inputSchema: {
      type: "object",
      properties: {
        projectRoot: {
          type: "string",
          description: "Project root directory. Defaults to current working directory.",
        },
        filePath: {
          type: "string",
          description: "Optional specific file path to filter diagnostics.",
        },
      },
    },
  },
  {
    name: "lsp_symbols",
    description:
      "Extract symbol declarations (functions, classes, interfaces, types, variables) from a file or directory.",
    inputSchema: {
      type: "object",
      properties: {
        projectRoot: {
          type: "string",
          description: "Project root directory. Defaults to current working directory.",
        },
        targetPath: {
          type: "string",
          description: "Optional file or directory path to inspect.",
        },
        exportedOnly: {
          type: "boolean",
          description: "When true, return only exported symbols.",
        },
      },
    },
  },
  {
    name: "lsp_definition",
    description: "Find the definition location(s) (file, line, column) of a symbol by name.",
    inputSchema: {
      type: "object",
      properties: {
        symbol: {
          type: "string",
          description: "Exact symbol identifier to locate.",
        },
        projectRoot: {
          type: "string",
          description: "Project root directory. Defaults to current working directory.",
        },
        targetPath: {
          type: "string",
          description: "Optional file or directory scope.",
        },
      },
      required: ["symbol"],
    },
  },
  {
    name: "lsp_references",
    description: "Find all references to a symbol across the project with line/column locations.",
    inputSchema: {
      type: "object",
      properties: {
        symbol: {
          type: "string",
          description: "Exact symbol identifier to search for.",
        },
        projectRoot: {
          type: "string",
          description: "Project root directory. Defaults to current working directory.",
        },
        targetPath: {
          type: "string",
          description: "Optional file or directory scope.",
        },
      },
      required: ["symbol"],
    },
  },
];

export interface AsdLspServerOptions {
  projectRoot?: string;
  runner?: LspCommandRunner;
}

export class AsdLspMcpServer {
  private readonly defaultRoot: string;
  private readonly runner?: LspCommandRunner;
  private rpcServer: StdioRpcServer | null = null;

  constructor(options?: AsdLspServerOptions) {
    this.defaultRoot = options?.projectRoot ?? process.cwd();
    this.runner = options?.runner;
  }

  public async handleRequest(
    method: string,
    params: unknown = {},
    _signal?: AbortSignal
  ): Promise<unknown> {
    const p = (params && typeof params === "object" ? params : {}) as Record<string, unknown>;

    if (method === "initialize") {
      return {
        protocolVersion: "2024-11-05",
        capabilities: { tools: {} },
        serverInfo: { name: "asd-lsp", version: "2.2.0" },
      };
    }

    if (method === "notifications/initialized" || method === "ping") {
      return {};
    }

    if (method === "tools/list") {
      return { tools: ASD_LSP_MCP_TOOLS };
    }

    if (method === "tools/call") {
      const toolName = String(p.name ?? "");
      const toolArgs = (
        p.arguments && typeof p.arguments === "object" ? p.arguments : {}
      ) as Record<string, unknown>;
      const result = await this.handleToolCall(toolName, toolArgs);
      return {
        content: [{ type: "text", text: JSON.stringify(result) }],
        structuredContent: result,
      };
    }

    return await this.handleToolCall(method, p);
  }

  public async handleToolCall(
    name: string,
    args: Record<string, unknown> = {}
  ): Promise<unknown> {
    const projectRoot =
      typeof args.projectRoot === "string" && args.projectRoot.trim().length > 0
        ? args.projectRoot
        : this.defaultRoot;

    switch (name) {
      case "lsp_diagnostics": {
        const filePath = typeof args.filePath === "string" ? args.filePath : undefined;
        return runDiagnostics({
          projectRoot,
          filePath,
          runner: this.runner,
        });
      }
      case "lsp_symbols": {
        const targetPath = typeof args.targetPath === "string" ? args.targetPath : undefined;
        const exportedOnly = Boolean(args.exportedOnly);
        const symbols = extractSymbols({
          projectRoot,
          targetPath,
          exportedOnly,
        });
        return { count: symbols.length, symbols };
      }
      case "lsp_definition": {
        const symbol = typeof args.symbol === "string" ? args.symbol : "";
        if (!symbol) {
          throw new Error("Missing required parameter 'symbol' for lsp_definition");
        }
        const targetPath = typeof args.targetPath === "string" ? args.targetPath : undefined;
        const definitions = findDefinition({
          projectRoot,
          symbol,
          targetPath,
        });
        return { symbol, count: definitions.length, definitions };
      }
      case "lsp_references": {
        const symbol = typeof args.symbol === "string" ? args.symbol : "";
        if (!symbol) {
          throw new Error("Missing required parameter 'symbol' for lsp_references");
        }
        const targetPath = typeof args.targetPath === "string" ? args.targetPath : undefined;
        const references = findReferences({
          projectRoot,
          symbol,
          targetPath,
        });
        return { symbol, count: references.length, references };
      }
      default:
        throw new Error(`Unknown LSP tool: ${name}`);
    }
  }

  public start(): StdioRpcServer {
    const rpc = new StdioRpcServer({
      handleRequest: (method, params, signal) => this.handleRequest(method, params, signal),
    });
    this.rpcServer = rpc;
    rpc.start();
    return rpc;
  }

  public stop(): void {
    this.rpcServer?.stop();
    this.rpcServer = null;
  }
}

export function createAsdLspMcpServer(options?: AsdLspServerOptions): AsdLspMcpServer {
  return new AsdLspMcpServer(options);
}

const currentFile = fileURLToPath(import.meta.url);
if (process.argv[1] && process.argv[1] === currentFile) {
  const srv = createAsdLspMcpServer();
  srv.start();
}
