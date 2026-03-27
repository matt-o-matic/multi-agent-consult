import "server-only";

import {
  braveSearch,
  fetchWebPage,
  openRouterNativeSearch,
} from "@/lib/services/web-tools";
import {
  listFiles,
  readFileFromWorkspace,
  runWorkspaceCheck,
  searchFilesInWorkspace,
} from "@/lib/services/workspace-tools";
import type { ProviderToolDefinition } from "@/lib/providers/base";
import type {
  ParticipantRole,
  SearchBackend,
  SourceRecord,
  ToolInvocationRecord,
  UserQuestionProposal,
  WorkspaceManifest,
} from "@/lib/types";

export interface ToolExecutionContext {
  runId: string;
  turnId: string;
  role: ParticipantRole;
  modelId: string;
  searchBackend: SearchBackend;
  workspaceManifest?: WorkspaceManifest | null;
}

export interface ToolExecutionResult {
  content: string;
  invocation: ToolInvocationRecord;
  sources: SourceRecord[];
  questionProposals?: UserQuestionProposal[];
}

export const participantToolDefinitions: ProviderToolDefinition[] = [
  {
    type: "function",
    function: {
      name: "web_search",
      description: "Search the web for recent information and return summarized results with sources.",
      parameters: {
        type: "object",
        properties: {
          query: {
            type: "string",
            description: "The search query to run.",
          },
        },
        required: ["query"],
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "fetch_web_page",
      description: "Fetch and read a single web page URL for deeper context.",
      parameters: {
        type: "object",
        properties: {
          url: {
            type: "string",
            description: "The URL to fetch.",
          },
        },
        required: ["url"],
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "list_files",
      description: "List files in the selected workspace.",
      parameters: {
        type: "object",
        properties: {
          relativePath: {
            type: "string",
            description: "Optional path relative to the workspace root.",
          },
        },
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "search_files",
      description: "Search workspace files for a string query.",
      parameters: {
        type: "object",
        properties: {
          query: { type: "string" },
          relativePath: { type: "string" },
        },
        required: ["query"],
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "read_file",
      description: "Read a text file from the workspace.",
      parameters: {
        type: "object",
        properties: {
          relativePath: { type: "string" },
          startLine: { type: "integer" },
          endLine: { type: "integer" },
        },
        required: ["relativePath"],
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "run_check",
      description: "Run a safe, pre-discovered read-only workspace command.",
      parameters: {
        type: "object",
        properties: {
          commandId: { type: "string" },
        },
        required: ["commandId"],
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "propose_user_questions",
      description:
        "Propose clarification questions for the referee to consider asking the user. These will not be shown directly to the user.",
      parameters: {
        type: "object",
        properties: {
          questions: {
            type: "array",
            minItems: 1,
            maxItems: 3,
            items: {
              type: "object",
              properties: {
                question: { type: "string" },
                rationale: { type: "string" },
                notePlaceholder: { type: "string" },
                options: {
                  type: "array",
                  minItems: 2,
                  maxItems: 4,
                  items: {
                    type: "object",
                    properties: {
                      id: { type: "string" },
                      label: { type: "string" },
                      description: { type: "string" },
                      recommended: { type: "boolean" },
                    },
                    required: ["id", "label", "description"],
                    additionalProperties: false,
                  },
                },
              },
              required: ["question", "options"],
              additionalProperties: false,
            },
          },
        },
        required: ["questions"],
        additionalProperties: false,
      },
    },
  },
];

function serializeToolContent(payload: unknown) {
  return JSON.stringify(payload, null, 2);
}

function baseInvocation(
  context: ToolExecutionContext,
  toolName: string,
  input: Record<string, unknown>,
): ToolInvocationRecord {
  return {
    id: crypto.randomUUID(),
    runId: context.runId,
    turnId: context.turnId,
    role: context.role,
    toolName,
    status: "started",
    inputJson: JSON.stringify(input),
    outputJson: null,
    errorMessage: null,
    createdAt: new Date().toISOString(),
  };
}

export async function executeTool(
  toolName: string,
  input: Record<string, unknown>,
  context: ToolExecutionContext,
): Promise<ToolExecutionResult> {
  const invocation = baseInvocation(context, toolName, input);

  try {
    let payload: unknown;
    let sources: SourceRecord[] = [];
    let questionProposals: UserQuestionProposal[] | undefined;

    switch (toolName) {
      case "web_search": {
        if (context.searchBackend === "off") {
          throw new Error("Web search is disabled for this run.");
        }

        const query = String(input.query ?? "");
        const searchResult =
          context.searchBackend === "brave"
            ? await braveSearch(query)
            : await openRouterNativeSearch(query, context.modelId);

        payload = {
          summary: searchResult.summary,
          results: searchResult.sources.map((source) => ({
            title: source.title,
            url: source.url,
            snippet: source.snippet,
          })),
        };
        sources = searchResult.sources;
        break;
      }
      case "fetch_web_page": {
        const url = String(input.url ?? "");
        const page = await fetchWebPage(url);
        payload = {
          title: page.title,
          url: page.url,
          content: page.content,
        };
        sources = page.sources;
        break;
      }
      case "list_files": {
        if (!context.workspaceManifest) {
          throw new Error("Workspace tools are disabled for this run.");
        }
        const files = await listFiles(
          context.workspaceManifest.rootPath,
          typeof input.relativePath === "string" ? input.relativePath : undefined,
        );
        payload = { files, workspaceRoot: context.workspaceManifest.rootPath };
        break;
      }
      case "search_files": {
        if (!context.workspaceManifest) {
          throw new Error("Workspace tools are disabled for this run.");
        }
        const matches = await searchFilesInWorkspace(
          context.workspaceManifest.rootPath,
          String(input.query ?? ""),
          typeof input.relativePath === "string" ? input.relativePath : undefined,
        );
        payload = { matches };
        break;
      }
      case "read_file": {
        if (!context.workspaceManifest) {
          throw new Error("Workspace tools are disabled for this run.");
        }
        const file = await readFileFromWorkspace(
          context.workspaceManifest.rootPath,
          String(input.relativePath ?? ""),
          typeof input.startLine === "number" ? input.startLine : 1,
          typeof input.endLine === "number" ? input.endLine : 200,
        );
        payload = file;
        break;
      }
      case "run_check": {
        if (!context.workspaceManifest) {
          throw new Error("Workspace tools are disabled for this run.");
        }
        const result = await runWorkspaceCheck(
          context.workspaceManifest,
          String(input.commandId ?? ""),
        );
        payload = result;
        break;
      }
      case "propose_user_questions": {
        const questions = Array.isArray(input.questions)
          ? (input.questions as UserQuestionProposal[])
          : [];
        questionProposals = questions.slice(0, 3);
        payload = {
          questions: questionProposals,
          note:
            "These are proposals for the referee to consider. They are not user-visible until approved by the referee.",
        };
        break;
      }
      default:
        throw new Error(`Unsupported tool "${toolName}".`);
    }

    const finalizedInvocation: ToolInvocationRecord = {
      ...invocation,
      status: "success",
      outputJson: JSON.stringify(payload),
    };
    const timestamp = finalizedInvocation.createdAt;

    const finalizedSources = sources.map((source) => ({
      ...source,
      toolInvocationId: finalizedInvocation.id,
      turnId: context.turnId,
      createdAt: source.createdAt || timestamp,
    }));

    return {
      content: serializeToolContent(payload),
      invocation: finalizedInvocation,
      sources: finalizedSources,
      questionProposals,
    };
  } catch (error) {
    const finalizedInvocation: ToolInvocationRecord = {
      ...invocation,
      status: "error",
      errorMessage: error instanceof Error ? error.message : "Unknown tool error",
    };

    return {
      content: finalizedInvocation.errorMessage ?? "Unknown tool error",
      invocation: finalizedInvocation,
      sources: [],
    };
  }
}
