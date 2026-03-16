/**
 * Streaming Chat Service
 * Handles SSE streaming from OpenAI-compatible endpoints
 * Uses Tauri HTTP plugin for proper CORS handling
 * Supports tool calling for web search and file reading
 */

import { fetch as tauriFetch } from '@tauri-apps/plugin-http';
import { listen, type UnlistenFn } from '@tauri-apps/api/event';
import { webSearch, fetchWebPage, formatSearchResultsAsContext, WebSearchOptions } from './webSearch';
import * as tauriIpc from './tauriIpc';

// Global references to active streaming resources for cancellation
let currentReader: ReadableStreamDefaultReader<Uint8Array> | null = null;
let currentStream: ReadableStream<Uint8Array> | null = null;
let currentTauriRequestId: string | null = null;
let currentTauriUnlisteners: UnlistenFn[] = [];

/**
 * Cancel the currently active stream
 */
export function cancelStream(): void {
  if (currentReader) {
    currentReader.cancel().catch(() => {
      // Ignore errors during cancel
    });
    currentReader = null;
  }
  if (currentStream) {
    currentStream.cancel().catch(() => {
      // Ignore errors during cancel
    });
    currentStream = null;
  }
  if (currentTauriRequestId && tauriIpc.isTauriAvailable()) {
    void tauriIpc.aiCancelStream(currentTauriRequestId).catch(() => {
      // Ignore backend cancel failures
    });
  }
  currentTauriRequestId = null;
  if (currentTauriUnlisteners.length > 0) {
    currentTauriUnlisteners.forEach((unlisten) => {
      try {
        unlisten();
      } catch {
        // Ignore listener cleanup errors
      }
    });
    currentTauriUnlisteners = [];
  }
}

export interface StreamMessage {
  role: 'user' | 'assistant' | 'system' | 'tool';
  content: StreamMessageContent;
  tool_calls?: ToolCall[];
  tool_call_id?: string;
}

export type StreamMessageContent =
  | string
  | Array<
    | { type: 'text'; text: string }
    | { type: 'image_url'; image_url: { url: string } }
  >;

export interface ToolCall {
  id: string;
  type: 'function';
  function: {
    name: string;
    arguments: string;
  };
}

export interface ToolResult {
  tool_call_id: string;
  content: string;
}

export interface StreamingChatOptions {
  providerId: string;
  providerType: string;
  baseUrl: string;
  apiKey?: string;
  modelId: string;
  messages: StreamMessage[];
  onToken: (token: string) => void;
  onComplete: (fullContent: string) => void;
  onError: (error: Error) => void;
  signal?: AbortSignal;
  // Tool calling options
  enableWebSearch?: boolean;
  enableWebFetch?: boolean;
  webSearchOptions?: WebSearchOptions;
  onToolCall?: (
    toolName: string,
    args: Record<string, unknown>
  ) => Promise<string | void> | string | void;
  onToolResult?: (toolName: string, result: string) => void;
  fileToolContext?: Array<{
    title: string;
    source: string;
    path?: string;
    snippet?: string;
  }>;
  allowedToolIds?: string[];
  showToolTraces?: boolean;
}

// Tool definitions for the LLM
const WEB_SEARCH_TOOL = {
  type: 'function',
  function: {
    name: 'web_search',
    description: 'Search the web for current information. Use this when you need up-to-date information about any topic.',
    parameters: {
      type: 'object',
      properties: {
        query: {
          type: 'string',
          description: 'The search query to look up',
        },
      },
      required: ['query'],
    },
  },
};

const WEB_FETCH_TOOL = {
  type: 'function',
  function: {
    name: 'web_fetch',
    description: 'Fetch and read the content of a specific URL.',
    parameters: {
      type: 'object',
      properties: {
        url: {
          type: 'string',
          description: 'URL to fetch and read',
        },
      },
      required: ['url'],
    },
  },
};

const MARK_SOURCE_PASSAGE_TOOL = {
  type: 'function',
  function: {
    name: 'mark_source_passage',
    description: 'Store important source passages. Use kind="interesting" for notable excerpts and kind="used" for excerpts directly used in the final answer.',
    parameters: {
      type: 'object',
      properties: {
        title: {
          type: 'string',
          description: 'Short title of the passage.',
        },
        passage: {
          type: 'string',
          description: 'Important excerpt to save.',
        },
        kind: {
          type: 'string',
          enum: ['interesting', 'used'],
          description: 'Classification of the passage: interesting while analyzing, or used in the final answer.',
        },
        reason: {
          type: 'string',
          description: 'Optional short reason describing why this passage matters.',
        },
        source: {
          type: 'string',
          description: 'Source label such as filename or site/domain.',
        },
        url: {
          type: 'string',
          description: 'URL of the source when available.',
        },
      },
      required: ['title', 'passage'],
    },
  },
};

const READ_SOURCES_TOOL = {
  type: 'function',
  function: {
    name: 'read_sources',
    description: 'Read saved source passages from the current conversation. Can filter by kind and query.',
    parameters: {
      type: 'object',
      properties: {
        kind: {
          type: 'string',
          enum: ['all', 'interesting', 'used'],
          description: 'Optional filter by source passage kind.',
        },
        query: {
          type: 'string',
          description: 'Optional keyword filter over title, passage, source, url, and reason.',
        },
        limit: {
          type: 'number',
          description: 'Optional maximum number of passages to return (1-50).',
        },
        include_snippet: {
          type: 'boolean',
          description: 'Include full passage snippets in results. Defaults to true.',
        },
      },
      required: [],
    },
  },
};

const EDIT_SOURCE_PASSAGE_TOOL = {
  type: 'function',
  function: {
    name: 'edit_source_passage',
    description: 'Update, reclassify, or delete a saved source passage by citation_id.',
    parameters: {
      type: 'object',
      properties: {
        citation_id: {
          type: 'string',
          description: 'ID of the source citation to modify.',
        },
        action: {
          type: 'string',
          enum: ['update', 'reclassify', 'delete'],
          description: 'Type of modification to apply.',
        },
        title: {
          type: 'string',
          description: 'Updated title for action="update".',
        },
        passage: {
          type: 'string',
          description: 'Updated passage text for action="update".',
        },
        source: {
          type: 'string',
          description: 'Updated source label for action="update".',
        },
        url: {
          type: 'string',
          description: 'Updated URL for action="update".',
        },
        reason: {
          type: 'string',
          description: 'Updated or new reason for action="update".',
        },
        kind: {
          type: 'string',
          enum: ['interesting', 'used'],
          description: 'Required for action="reclassify". Optional for action="update".',
        },
      },
      required: ['citation_id', 'action'],
    },
  },
};

const READ_FILE_TOOL = {
  type: 'function',
  function: {
    name: 'read_file',
    description: 'Read a file already attached in the conversation context. Use this when asked to analyze or inspect a file.',
    parameters: {
      type: 'object',
      properties: {
        file: {
          type: 'string',
          description: 'File name/path/source to read (example: hotas.pr0).',
        },
        extract_text: {
          type: 'boolean',
          description: 'Optional hint to request text extraction for binary-like formats (e.g. .docx).',
        },
      },
      required: ['file'],
    },
  },
};

const LIST_TOOL = {
  type: 'function',
  function: {
    name: 'list',
    description: 'List files and directories under a path in the local workspace. In a global project, the visible root can be virtual and contain only subproject mounts such as api/ or web/.',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Directory path to list. Defaults to the current execution workspace root for this conversation.' },
        project_id: { type: 'string', description: 'Optional subproject identifier when you want to force which subproject to use.' },
        recursive: { type: 'boolean', description: 'Whether to list recursively.' },
        include_hidden: { type: 'boolean', description: 'Include hidden files/folders.' },
        max_depth: { type: 'number', description: 'Maximum recursion depth when recursive=true.' },
      },
      required: [],
    },
  },
};

const READ_WORKSPACE_TOOL = {
  type: 'function',
  function: {
    name: 'read',
    description: 'Read a file from the local execution workspace by path. In a virtual global project root, prefer paths like api/src/server.ts or pass project_id.',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Path of the file to read.' },
        project_id: { type: 'string', description: 'Optional subproject identifier when you want to force which subproject to use.' },
        start_line: { type: 'number', description: 'Optional 1-based start line.' },
        end_line: { type: 'number', description: 'Optional 1-based end line.' },
      },
      required: ['path'],
    },
  },
};

const WRITE_WORKSPACE_TOOL = {
  type: 'function',
  function: {
    name: 'write',
    description: 'Create or overwrite a file in the current execution workspace with full content. In a virtual global project root, pass project_id or use a mount-prefixed path such as api/src/server.ts.',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Path of the file to write.' },
        project_id: { type: 'string', description: 'Optional subproject identifier when you want to force which subproject to use.' },
        content: { type: 'string', description: 'Final file content.' },
        create_dirs: { type: 'boolean', description: 'Create missing parent directories.' },
      },
      required: ['path', 'content'],
    },
  },
};

const EDIT_WORKSPACE_TOOL = {
  type: 'function',
  function: {
    name: 'edit',
    description: 'Edit a file in the current execution workspace by replacing exact text. In a virtual global project root, pass project_id or use a mount-prefixed path such as api/src/server.ts.',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Path of the file to edit.' },
        project_id: { type: 'string', description: 'Optional subproject identifier when you want to force which subproject to use.' },
        old_text: { type: 'string', description: 'Exact text to replace.' },
        new_text: { type: 'string', description: 'Replacement text.' },
        replace_all: { type: 'boolean', description: 'Replace all matches (default false = first only).' },
      },
      required: ['path', 'old_text', 'new_text'],
    },
  },
};

const GLOB_WORKSPACE_TOOL = {
  type: 'function',
  function: {
    name: 'glob',
    description: 'Find files in the current execution workspace matching a glob pattern. In a virtual global project root, results are returned as mountName/path such as api/src/server.ts.',
    parameters: {
      type: 'object',
      properties: {
        pattern: { type: 'string', description: 'Glob pattern.' },
        project_id: { type: 'string', description: 'Optional subproject identifier when you want to force which subproject to use.' },
        include_hidden: { type: 'boolean', description: 'Include hidden files/folders.' },
      },
      required: ['pattern'],
    },
  },
};

const GREP_WORKSPACE_TOOL = {
  type: 'function',
  function: {
    name: 'grep',
    description: 'Search text in files under the current execution workspace. In a virtual global project root, results are returned as mountName/path such as api/src/server.ts.',
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Text or regex to search for.' },
        project_id: { type: 'string', description: 'Optional subproject identifier when you want to force which subproject to use.' },
        is_regexp: { type: 'boolean', description: 'Treat query as regex when true.' },
        include_pattern: { type: 'string', description: 'Optional file glob filter.' },
        include_hidden: { type: 'boolean', description: 'Include hidden files/folders.' },
        max_results: { type: 'number', description: 'Maximum result rows to return.' },
      },
      required: ['query'],
    },
  },
};

const GIT_STATUS_TOOL = {
  type: 'function',
  function: {
    name: 'git_status',
    description: 'Get git status for exactly one subproject repository context. There is no git status at the virtual global root.',
    parameters: {
      type: 'object',
      properties: {
        project_id: { type: 'string', description: 'Optional subproject identifier when you want to force which subproject to use.' },
        repo_path: { type: 'string', description: 'Optional repository path override. In a virtual global root, you can use mount-prefixed values such as api or api/src.' },
      },
      required: [],
    },
  },
};

const GIT_LOG_TOOL = {
  type: 'function',
  function: {
    name: 'git_log',
    description: 'Get git commit history.',
    parameters: {
      type: 'object',
      properties: {
        repo_path: { type: 'string' },
        project_id: { type: 'string' },
        limit: { type: 'number' },
        branch: { type: 'string' },
      },
      required: [],
    },
  },
};

const GIT_BRANCH_LIST_TOOL = {
  type: 'function',
  function: {
    name: 'git_branch_list',
    description: 'List local and remote branches.',
    parameters: {
      type: 'object',
      properties: {
        repo_path: { type: 'string' },
        project_id: { type: 'string' },
      },
      required: [],
    },
  },
};

const GIT_DIFF_TOOL = {
  type: 'function',
  function: {
    name: 'git_diff',
    description: 'Generate repository diff.',
    parameters: {
      type: 'object',
      properties: {
        repo_path: { type: 'string' },
        project_id: { type: 'string' },
        base: { type: 'string' },
        head: { type: 'string' },
        context_lines: { type: 'number' },
        ignore_whitespace: { type: 'boolean' },
        paths: { type: 'array', items: { type: 'string' } },
      },
      required: [],
    },
  },
};

const GIT_GET_TREE_TOOL = {
  type: 'function',
  function: {
    name: 'git_get_tree',
    description: 'Get predicted git tree for current branch/repository.',
    parameters: {
      type: 'object',
      properties: {
        repo_path: { type: 'string' },
        project_id: { type: 'string' },
        branch: { type: 'string' },
      },
      required: [],
    },
  },
};

const GIT_ADD_TOOL = {
  type: 'function',
  function: {
    name: 'git_add',
    description: 'Stage files in the repository index.',
    parameters: {
      type: 'object',
      properties: {
        repo_path: { type: 'string' },
        project_id: { type: 'string' },
        paths: { type: 'array', items: { type: 'string' } },
      },
      required: [],
    },
  },
};

const GIT_COMMIT_TOOL = {
  type: 'function',
  function: {
    name: 'git_commit',
    description: 'Create commit in repository.',
    parameters: {
      type: 'object',
      properties: {
        repo_path: { type: 'string' },
        project_id: { type: 'string' },
        message: { type: 'string' },
        stage_all: { type: 'boolean' },
      },
      required: ['message'],
    },
  },
};

const GIT_CHECKOUT_TOOL = {
  type: 'function',
  function: {
    name: 'git_checkout',
    description: 'Checkout branch or commit, optionally creating branch.',
    parameters: {
      type: 'object',
      properties: {
        repo_path: { type: 'string' },
        project_id: { type: 'string' },
        branch_or_commit: { type: 'string' },
        create: { type: 'boolean' },
      },
      required: ['branch_or_commit'],
    },
  },
};

const GIT_MERGE_TOOL = {
  type: 'function',
  function: {
    name: 'git_merge',
    description: 'Merge a source branch into a target branch for exactly one subproject repository context.',
    parameters: {
      type: 'object',
      properties: {
        repo_path: { type: 'string' },
        project_id: { type: 'string' },
        branch_name: { type: 'string' },
        into_branch: { type: 'string' },
      },
      required: ['branch_name', 'into_branch'],
    },
  },
};

const GIT_RESET_TOOL = {
  type: 'function',
  function: {
    name: 'git_reset',
    description: 'Reset repository to commit/HEAD in soft/mixed/hard mode.',
    parameters: {
      type: 'object',
      properties: {
        repo_path: { type: 'string' },
        project_id: { type: 'string' },
        mode: { type: 'string', enum: ['soft', 'mixed', 'hard'] },
        commit: { type: 'string' },
        confirm: { type: 'boolean' },
      },
      required: ['mode'],
    },
  },
};

const GIT_STASH_TOOL = {
  type: 'function',
  function: {
    name: 'git_stash',
    description: 'Stash local changes.',
    parameters: {
      type: 'object',
      properties: {
        repo_path: { type: 'string' },
        project_id: { type: 'string' },
        message: { type: 'string' },
      },
      required: [],
    },
  },
};

const TERMINAL_CREATE_SESSION_TOOL = {
  type: 'function',
  function: {
    name: 'terminal_create_session',
    description: 'Create a terminal session bound to exactly one subproject. project_id is required. There is no terminal at the virtual global root.',
    parameters: {
      type: 'object',
      properties: {
        project_id: { type: 'string', description: 'Required subproject identifier.' },
        cwd: { type: 'string', description: 'Optional directory under the selected subproject or worktree.' },
      },
      required: ['project_id'],
    },
  },
};

const TERMINAL_RUN_TOOL = {
  type: 'function',
  function: {
    name: 'terminal_run',
    description: 'Run a shell command inside an existing terminal session.',
    parameters: {
      type: 'object',
      properties: {
        session_id: { type: 'string', description: 'Terminal session identifier returned by terminal_create_session.' },
        command: { type: 'string', description: 'Shell command to execute.' },
        timeout_ms: { type: 'number', description: 'Optional timeout in milliseconds.' },
      },
      required: ['session_id', 'command'],
    },
  },
};

const TERMINAL_READ_TOOL = {
  type: 'function',
  function: {
    name: 'terminal_read',
    description: 'Read the latest output and status from an existing terminal session.',
    parameters: {
      type: 'object',
      properties: {
        session_id: { type: 'string', description: 'Terminal session identifier returned by terminal_create_session.' },
      },
      required: ['session_id'],
    },
  },
};

const TERMINAL_KILL_TOOL = {
  type: 'function',
  function: {
    name: 'terminal_kill',
    description: 'Kill the active process in an existing terminal session.',
    parameters: {
      type: 'object',
      properties: {
        session_id: { type: 'string', description: 'Terminal session identifier returned by terminal_create_session.' },
      },
      required: ['session_id'],
    },
  },
};

const ADD_NEED_TOOL = {
  type: 'function',
  function: {
    name: 'need_add',
    description: 'Add a structured user or system need for the project. Use this during the Architect phase to gather requirements.',
    parameters: {
      type: 'object',
      properties: {
        title: { type: 'string', description: 'Short title of the need.' },
        description: { type: 'string', description: 'Detailed description of what is needed.' },
        target_branch: { type: 'string', description: 'Optional target code branch for the active plan context.' },
        category: { type: 'string', enum: ['functional', 'technical', 'ux', 'security', 'other'], description: 'Category of the need.' },
        priority: { type: 'string', enum: ['low', 'medium', 'high'], description: 'Priority level.' },
        tags: { type: 'array', items: { type: 'string' }, description: 'Keywords or tags.' },
      },
      required: ['title', 'description', 'category', 'priority'],
    },
  },
};

export const GENERATE_PLAN_TOOL = {
  type: 'function',
  function: {
    name: 'strategy_generate',
    description: 'Generate a structured strategy for the active plan based on collected needs. New plans use a generated plan identifier as the canonical slug, so plan branches are plan/<plan-id> and feature branches are feature/<plan-id>/<feature-slug>.',
    parameters: {
      type: 'object',
      properties: {
        plan_id: { type: 'string', description: 'Optional existing plan ID to update.' },
        plan_title: { type: 'string', description: 'Optional secondary plan label to persist. For legacy plans this remains a title alias.' },
        plan_description: { type: 'string', description: 'Optional plan description for persistence in @macro metadata.' },
        target_branch: { type: 'string', description: 'Code branch this plan is associated with.' },
        nodes: {
          type: 'array',
          items: {
            type: 'object',
              properties: {
                title: { type: 'string' },
                description: { type: 'string' },
                type: { type: 'string', enum: ['spec', 'feature', 'task', 'milestone'] },
                assignedBranch: { type: 'string', description: 'The git branch name this task belongs to, e.g. "feature/1710000000000/auth-api"' },
                dependencies: { type: 'array', items: { type: 'string' }, description: 'Titles of nodes this one depends on.' },
              },
              required: ['title', 'type', 'assignedBranch'],
          },
          description: 'List of plan nodes representing the tasks to be done.',
        },
      },
      required: ['nodes'],
    },
  },
};

export const CREATE_PLAN_TOOL = {
  type: 'function',
  function: {
    name: 'plan_create',
    description: 'Create a new Architect plan stored under the @macro branch metadata for a target code branch. New plans are created immediately with a generated identifier; title is optional and treated as an initial secondary label.',
    parameters: {
      type: 'object',
      properties: {
        label: { type: 'string', description: 'Optional secondary plan label.' },
        title: { type: 'string', description: 'Legacy alias for label. Optional.' },
        description: { type: 'string' },
        target_branch: { type: 'string', description: 'Code branch this plan belongs to (e.g. develop, feature/auth).' },
        status: { type: 'string', enum: ['draft', 'validated', 'in_progress', 'completed', 'archived', 'deleted'] },
        set_active: { type: 'boolean' },
      },
      required: [],
    },
  },
};

export const LIST_PLANS_TOOL = {
  type: 'function',
  function: {
    name: 'plan_list',
    description: 'List plans for a code branch in the @macro branch metadata.',
    parameters: {
      type: 'object',
      properties: {
        target_branch: { type: 'string' },
        include_deleted: { type: 'boolean' },
        include_archived: { type: 'boolean' },
      },
      required: [],
    },
  },
};

export const GET_PLAN_TOOL = {
  type: 'function',
  function: {
    name: 'plan_get',
    description: 'Read a specific plan and its nodes from @macro metadata.',
    parameters: {
      type: 'object',
      properties: {
        plan_id: { type: 'string' },
        target_branch: { type: 'string' },
      },
      required: ['plan_id'],
    },
  },
};

export const UPDATE_PLAN_TOOL = {
  type: 'function',
  function: {
    name: 'plan_update',
    description: 'Update the optional label/title alias, description, status, or active flag for an existing plan. For new plans, label changes never rename the canonical id or slug used for git branches.',
    parameters: {
      type: 'object',
      properties: {
        plan_id: { type: 'string' },
        label: { type: 'string', description: 'Optional secondary label for the plan.' },
        title: { type: 'string', description: 'Legacy alias. For new plans this updates the optional secondary label.' },
        description: { type: 'string' },
        status: { type: 'string', enum: ['draft', 'validated', 'in_progress', 'completed', 'archived', 'deleted'] },
        target_branch: { type: 'string' },
        set_active: { type: 'boolean' },
      },
      required: ['plan_id'],
    },
  },
};

export const DELETE_PLAN_TOOL = {
  type: 'function',
  function: {
    name: 'plan_delete',
    description: 'Delete a plan. Soft delete by default; hard delete when hard_delete=true.',
    parameters: {
      type: 'object',
      properties: {
        plan_id: { type: 'string' },
        target_branch: { type: 'string' },
        hard_delete: { type: 'boolean' },
      },
      required: ['plan_id'],
    },
  },
};

export const RESTORE_PLAN_TOOL = {
  type: 'function',
  function: {
    name: 'plan_restore',
    description: 'Restore a soft-deleted plan back to draft status.',
    parameters: {
      type: 'object',
      properties: {
        plan_id: { type: 'string' },
        target_branch: { type: 'string' },
      },
      required: ['plan_id'],
    },
  },
};

export const SET_ACTIVE_PLAN_TOOL = {
  type: 'function',
  function: {
    name: 'plan_set_active',
    description: 'Set active plan for a target code branch in @macro metadata.',
    parameters: {
      type: 'object',
      properties: {
        plan_id: { type: 'string' },
        target_branch: { type: 'string' },
      },
      required: ['plan_id'],
    },
  },
};

const GET_STRATEGY_TOOL = {
  type: 'function',
  function: {
    name: 'strategy_get',
    description: 'Read the current strategy (nodes and branches) for the active plan.',
    parameters: {
      type: 'object',
      properties: {
        target_branch: { type: 'string' },
      },
      required: [],
    },
  },
};

const UPDATE_STRATEGY_TOOL = {
  type: 'function',
  function: {
    name: 'strategy_update',
    description: 'Modify strategy for the active plan. You can replace all nodes or apply operations (add, update, remove).',
    parameters: {
      type: 'object',
      properties: {
        target_branch: { type: 'string' },
        replace: { type: 'boolean', description: 'If true, replace strategy with provided nodes.' },
        nodes: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              id: { type: 'string' },
              title: { type: 'string' },
              description: { type: 'string' },
              type: { type: 'string', enum: ['spec', 'feature', 'task', 'milestone'] },
              assignedBranch: { type: 'string' },
              status: { type: 'string', enum: ['pending', 'in-progress', 'completed', 'blocked'] },
              dependencies: { type: 'array', items: { type: 'string' } },
            },
            required: ['title', 'type'],
          },
        },
        operations: {
          type: 'array',
          description: 'Patch operations applied in order.',
          items: {
            type: 'object',
            properties: {
              action: { type: 'string', enum: ['add', 'update', 'remove'] },
              node_id: { type: 'string' },
              title: { type: 'string' },
              description: { type: 'string' },
              type: { type: 'string', enum: ['spec', 'feature', 'task', 'milestone'] },
              assignedBranch: { type: 'string' },
              status: { type: 'string', enum: ['pending', 'in-progress', 'completed', 'blocked'] },
              dependencies: { type: 'array', items: { type: 'string' } },
            },
            required: ['action'],
          },
        },
      },
      required: [],
    },
  },
};

const DELETE_STRATEGY_TOOL = {
  type: 'function',
  function: {
    name: 'strategy_delete',
    description: 'Delete all strategy nodes and predicted branches for the active plan. Requires confirm=true.',
    parameters: {
      type: 'object',
      properties: {
        target_branch: { type: 'string' },
        confirm: { type: 'boolean' },
      },
      required: ['confirm'],
    },
  },
};

/**
 * Send a streaming chat completion request
 */
const createStreamingRequestId = () => {
  if (typeof crypto !== 'undefined' && 'randomUUID' in crypto) {
    return crypto.randomUUID();
  }

  return `req_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
};

const clearTauriListeners = () => {
  if (currentTauriUnlisteners.length > 0) {
    currentTauriUnlisteners.forEach((unlisten) => {
      try {
        unlisten();
      } catch {
        // Ignore listener cleanup errors
      }
    });
    currentTauriUnlisteners = [];
  }
};

const streamChatGptTurnViaTauri = async (params: {
  providerId: string;
  modelId: string;
  messages: StreamMessage[];
  signal?: AbortSignal;
  onDelta: (delta: string) => void;
}): Promise<string> => {
  if (!tauriIpc.isTauriAvailable()) {
    throw new Error('ChatGPT provider requires the desktop backend.');
  }

  clearTauriListeners();

  const requestId = createStreamingRequestId();
  currentTauriRequestId = requestId;

  let fullContent = '';

  return new Promise<string>((resolve, reject) => {
    let settled = false;

    const finish = (fn: () => void) => {
      if (settled) return;
      settled = true;
      clearTauriListeners();
      currentTauriRequestId = null;
      fn();
    };

    const signalHandler = () => {
      void tauriIpc.aiCancelStream(requestId).catch(() => {
        // Ignore backend cancel failures
      });
      finish(() => reject(new DOMException('Aborted', 'AbortError')));
    };

    if (params.signal?.aborted) {
      signalHandler();
      return;
    }

    if (params.signal) {
      params.signal.addEventListener('abort', signalHandler, { once: true });
    }

    void (async () => {
      try {
        const unlisteners = await Promise.all([
          listen<tauriIpc.AiStreamChunkEvent>('ai:stream', (event) => {
            if (event.payload.request_id !== requestId) return;
            fullContent += event.payload.delta;
            params.onDelta(event.payload.delta);
          }),
          listen<tauriIpc.AiStreamDoneEvent>('ai:done', (event) => {
            if (event.payload.request_id !== requestId) return;
            if (params.signal) {
              params.signal.removeEventListener('abort', signalHandler);
            }
            finish(() => resolve(fullContent));
          }),
          listen<tauriIpc.AiStreamErrorEvent>('ai:error', (event) => {
            if (event.payload.request_id !== requestId) return;
            if (params.signal) {
              params.signal.removeEventListener('abort', signalHandler);
            }
            finish(() => reject(new Error(event.payload.message)));
          }),
        ]);

        currentTauriUnlisteners = unlisteners;

        await tauriIpc.aiStreamChat({
          requestId,
          providerId: params.providerId,
          modelId: params.modelId,
          messages: params.messages.map((message) => ({
            role: message.role,
            content: message.content,
          })),
        });
      } catch (error) {
        if (params.signal) {
          params.signal.removeEventListener('abort', signalHandler);
        }
        finish(() => reject(error instanceof Error ? error : new Error(String(error))));
      }
    })();
  });
};

const streamChatViaChatGptProvider = async (options: StreamingChatOptions): Promise<void> => {
  const {
    providerId,
    modelId,
    messages,
    onToken,
    onComplete,
    onError,
    enableWebSearch = true,
    enableWebFetch = true,
    webSearchOptions,
    onToolCall,
    onToolResult,
    fileToolContext = [],
    allowedToolIds,
    showToolTraces = false,
  } = options;

  const allowedTools = new Set(allowedToolIds ?? []);

  const formatToolUsageLabel = (toolName: string, args: Record<string, unknown>) => {
    if (toolName === 'web_search') {
      const query = typeof args.query === 'string' ? args.query : '';
      return `\n\n[TOOL] web_search${query ? ` ("${query}")` : ''}\n`;
    }

    if (toolName === 'web_fetch') {
      const url = typeof args.url === 'string' ? args.url : '';
      return `\n\n[TOOL] web_fetch${url ? ` ("${url}")` : ''}\n`;
    }

    if (toolName === 'read_file') {
      const file = typeof args.file === 'string' ? args.file : '';
      return `\n\n[TOOL] read_file${file ? ` ("${file}")` : ''}\n`;
    }

    return `\n\n[TOOL] ${toolName}\n`;
  };

  let currentMessages: StreamMessage[] = [...messages];
  let fullContent = '';
  const readEvidenceBySource = new Map<string, string>();
  const MAX_TURNS = 10;
  let turnCount = 0;

  const normalizeSourceKey = (value?: string): string =>
    (value || '')
      .trim()
      .replace(/\\/g, '/')
      .replace(/^\.\//, '')
      .toLowerCase();

  const rememberReadEvidence = (source: string, content: string) => {
    const key = normalizeSourceKey(source);
    if (!key || !content.trim()) return;
    readEvidenceBySource.set(key, content);
  };

  const rememberReadEvidenceFromWorkspaceResult = (result: string) => {
    const fileHeaderMatch = result.match(/^FILE:\s*(.+)$/m);
    if (!fileHeaderMatch) return;

    const filePath = fileHeaderMatch[1].trim();
    const separatorIndex = result.indexOf('\n\n');
    const content = separatorIndex >= 0 ? result.slice(separatorIndex + 2) : '';
    rememberReadEvidence(filePath, content);
  };

  try {
    while (turnCount < MAX_TURNS) {
      if (options.signal?.aborted) {
        onComplete(options.messages.length > 0 ? '' : 'Request cancelled');
        return;
      }

      const turnContent = await streamChatGptTurnViaTauri({
        providerId,
        modelId,
        messages: currentMessages,
        signal: options.signal,
        onDelta: (delta) => {
          fullContent += delta;
          onToken(delta);
        },
      });

      const toolCalls: ToolCall[] = [];
      const inlineToolRegex = /<tool_call>\s*(?=\{)([\s\S]*?)\s*<\/tool_call>/gi;
      let match: RegExpExecArray | null;
      const inlineReplacements: Array<{ original: string }> = [];

      while ((match = inlineToolRegex.exec(turnContent)) !== null) {
        try {
          const parsed = JSON.parse(match[1].trim());
          if (parsed.name) {
            toolCalls.push({
              id: `call_${Date.now()}_${Math.random().toString(36).substring(2, 9)}`,
              type: 'function',
              function: {
                name: parsed.name,
                arguments: typeof parsed.arguments === 'string'
                  ? parsed.arguments
                  : JSON.stringify(parsed.arguments || {}),
              },
            });
            inlineReplacements.push({ original: match[0] });
          }
        } catch {
          console.warn('Failed to parse inline JSON tool call', match[1]);
        }
      }

      if (turnContent.trim().length > 0) {
        currentMessages.push({
          role: 'assistant',
          content: turnContent,
        });
      }

      for (const replacement of inlineReplacements) {
        fullContent = fullContent.replace(replacement.original, '');
      }

      const validToolCalls = toolCalls.filter((toolCall) => toolCall.id && toolCall.function.name);
      if (validToolCalls.length === 0) {
        break;
      }

      const toolResults: ToolResult[] = [];

      for (const toolCall of validToolCalls) {
        const toolName = toolCall.function.name;
        let toolResult = '';
        let customToolResult: string | undefined;

        try {
          const args = JSON.parse(toolCall.function.arguments);

          if (!allowedTools.has(toolName)) {
            toolResult = `Tool ${toolName} is disabled for the current mode.`;
            toolResults.push({ tool_call_id: toolCall.id, content: toolResult });
            continue;
          }

          const customResult = await onToolCall?.(toolName, args);
          customToolResult = typeof customResult === 'string' ? customResult : undefined;

          if (showToolTraces) {
            const toolUsageMsg = formatToolUsageLabel(toolName, args);
            fullContent += toolUsageMsg;
            onToken(toolUsageMsg);
          }

          if (toolName === 'web_search') {
            if (!enableWebSearch || (!webSearchOptions?.tavilyApiKey && !webSearchOptions?.braveApiKey)) {
              toolResult = 'Web search is not configured for this provider.';
              onToolResult?.(toolName, toolResult);
              toolResults.push({ tool_call_id: toolCall.id, content: toolResult });
              continue;
            }
            const searchResults = await webSearch(args.query, webSearchOptions);
            toolResult = formatSearchResultsAsContext(searchResults);

            if (showToolTraces) {
              const searchMsg = `\n\n🔍 **Recherche web:** "${args.query}"\n`;
              fullContent += searchMsg;
              onToken(searchMsg);
            }
          }

          if (toolName === 'web_fetch') {
            if (!enableWebFetch) {
              toolResult = 'Web fetch is disabled for this provider.';
              onToolResult?.(toolName, toolResult);
              toolResults.push({ tool_call_id: toolCall.id, content: toolResult });
              continue;
            }
            const url = typeof args.url === 'string' ? args.url : '';
            if (!url.trim()) {
              toolResult = 'Missing URL for web_fetch.';
            } else {
              const fetched = await fetchWebPage(url);
              toolResult = `TITLE: ${fetched.title}\nURL: ${fetched.url}\n\n${fetched.content}`;
            }
          }

          if (toolName === 'read_file') {
            const normalizeMatch = (value?: string) =>
              (value || '')
                .trim()
                .normalize('NFD')
                .replace(/[\u0300-\u036f]/g, '')
                .toLowerCase();

            const requestedRaw = typeof args.file === 'string' ? args.file.trim() : '';
            const requested = normalizeMatch(requestedRaw);
            const extractText = args.extract_text === true;
            const available = fileToolContext.map((f) => f.path || f.title || f.source).filter(Boolean);
            let workspaceReadAttempted = false;
            const workspaceMode = allowedTools.has('read') || allowedTools.has('list');

            if (requestedRaw && allowedTools.has('read') && onToolCall) {
              workspaceReadAttempted = true;
              const workspaceResult = await onToolCall('read', {
                path: requestedRaw,
                start_line: typeof args.start_line === 'number' ? args.start_line : undefined,
                end_line: typeof args.end_line === 'number' ? args.end_line : undefined,
              });

              if (typeof workspaceResult === 'string' && workspaceResult.trim()) {
                const isWorkspaceReadError =
                  /^Error executing read:/i.test(workspaceResult) ||
                  /^Missing\s+/i.test(workspaceResult) ||
                  /^No match found/i.test(workspaceResult) ||
                  /^File not found/i.test(workspaceResult) ||
                  /^Cannot\s+/i.test(workspaceResult);

                if (isWorkspaceReadError) {
                  toolResult = `Error executing tool read_file: ${workspaceResult}`;
                } else {
                  toolResult = workspaceResult;
                  rememberReadEvidenceFromWorkspaceResult(workspaceResult);
                }
              } else {
                toolResult = 'Error executing tool read_file: workspace read returned no content.';
              }
            }

            if (!toolResult.trim()) {
              if (workspaceReadAttempted) {
                toolResult = `Error executing tool read_file: unable to read "${requestedRaw}" from workspace.`;
              } else if (workspaceMode) {
                toolResult =
                  `Error executing tool read_file: workspace read tool is unavailable for "${requestedRaw}".` +
                  ' Use the read tool directly with an explicit path.';
              } else {
                const contextMatch = fileToolContext.find((file) => {
                  const title = normalizeMatch(file.title);
                  const source = normalizeMatch(file.source);
                  const path = normalizeMatch(file.path);
                  return (
                    requested === title ||
                    requested === source ||
                    requested === path ||
                    title.includes(requested) ||
                    source.includes(requested) ||
                    path.includes(requested)
                  );
                });

                if (!requested) {
                  toolResult = `No file provided. Available files: ${available.join(', ') || 'none'}`;
                } else if (!contextMatch) {
                  toolResult = `File not found in context: "${requestedRaw}". Available files: ${available.join(', ') || 'none'}`;
                } else {
                  const label = contextMatch.path || contextMatch.title || contextMatch.source;
                  const content = (contextMatch.snippet || '').trim();
                  const base = content
                    ? `FILE: ${label}\nSOURCE: CONTEXT_SNIPPET\n\n${content}`
                    : `FILE: ${label}\nSOURCE: CONTEXT_SNIPPET\n\nNo textual content available for this file in context.`;

                  const isDocx = /\.docx$/i.test(label || '');
                  const extractNotice =
                    extractText && isDocx
                      ? '\n\nNote: extract_text=true requested. Rich DOCX extraction is not available in this build; using available context text.'
                      : '';

                  toolResult = `${base}${extractNotice}`;
                  if (label) {
                    rememberReadEvidence(label, content);
                  }
                }
              }
            }
          }

          if (toolName === 'mark_source_passage') {
            const rawKind = typeof args.kind === 'string' ? args.kind.trim().toLowerCase() : '';
            const kind = rawKind === 'interesting' ? 'interesting' : 'used';
            const source = typeof args.source === 'string' ? args.source : '';
            const title = typeof args.title === 'string' ? args.title : '';
            const passage = typeof args.passage === 'string' ? args.passage : '';
            const normalizedPassage = passage.trim();

            const sourceKey = normalizeSourceKey(source || title);
            const sourceEvidence = sourceKey ? readEvidenceBySource.get(sourceKey) : undefined;
            const anyEvidence = Array.from(readEvidenceBySource.values());
            const hasMatchingEvidence = normalizedPassage
              ? (
                (sourceEvidence && sourceEvidence.includes(normalizedPassage)) ||
                anyEvidence.some((evidence) => evidence.includes(normalizedPassage))
              )
              : false;

            if (!hasMatchingEvidence) {
              toolResult = 'Error executing tool mark_source_passage: passage is not present in previously read file content.';
            } else {
              toolResult = `Source passage marked successfully (kind=${kind}).`;
            }
          } else if (toolName === 'read_sources') {
            toolResult = customToolResult || 'No source passages available.';
          } else if (toolName === 'edit_source_passage') {
            toolResult = customToolResult || 'Source passage edit request processed.';
          } else if (customToolResult) {
            toolResult = customToolResult;
          } else if (toolName !== 'web_search' && toolName !== 'read_file' && toolName !== 'web_fetch') {
            toolResult = `Unsupported tool: ${toolName}`;
          }

          onToolResult?.(toolName, toolResult);
        } catch (error) {
          toolResult = `Error executing tool ${toolName}: ${error instanceof Error ? error.message : String(error)}`;
          onToolResult?.(toolName, toolResult);
        }

        toolResults.push({
          tool_call_id: toolCall.id,
          content: toolResult,
        });
      }

      if (toolResults.length > 0) {
        const textResults = toolResults.map((toolResult) =>
          `[Tool Result for ${validToolCalls.find((toolCall) => toolCall.id === toolResult.tool_call_id)?.function.name}]:\n${toolResult.content}`
        ).join('\n\n');

        currentMessages.push({
          role: 'user',
          content: `Here are the results of the tools you called:\n\n${textResults}\n\nPlease continue your task using these results.`,
        });
      }

      turnCount++;
    }

    onComplete(fullContent);
  } catch (error) {
    if (error instanceof Error && error.name === 'AbortError') {
      onComplete(options.messages.length > 0 ? '' : 'Request cancelled');
      return;
    }

    const err = error instanceof Error ? error : new Error(String(error));
    onError(err);
  } finally {
    clearTauriListeners();
    currentTauriRequestId = null;
  }
};

export async function streamChat(options: StreamingChatOptions): Promise<void> {
  if (options.providerType === 'chatgpt') {
    return streamChatViaChatGptProvider(options);
  }

  const {
    providerId,
    providerType,
    baseUrl,
    apiKey,
    modelId,
    messages,
    onToken,
    onComplete,
    onError,
    enableWebSearch = true,
    enableWebFetch = true,
    webSearchOptions,
    onToolCall,
    onToolResult,
    fileToolContext = [],
    allowedToolIds,
    showToolTraces = false,
    // Note: signal is not used with Tauri HTTP plugin - AbortController support is limited
  } = options;

  const allowedTools = new Set(allowedToolIds ?? []);

  const formatToolUsageLabel = (toolName: string, args: Record<string, unknown>) => {
    if (toolName === 'web_search') {
      const query = typeof args.query === 'string' ? args.query : '';
      return `\n\n[TOOL] web_search${query ? ` ("${query}")` : ''}\n`;
    }

    if (toolName === 'web_fetch') {
      const url = typeof args.url === 'string' ? args.url : '';
      return `\n\n[TOOL] web_fetch${url ? ` ("${url}")` : ''}\n`;
    }

    if (toolName === 'mark_source_passage') {
      const title = typeof args.title === 'string' ? args.title : '';
      const kind = typeof args.kind === 'string' ? args.kind : 'used';
      return `\n\n[TOOL] mark_source_passage${title ? ` ("${title}", kind=${kind})` : ''}\n`;
    }

    if (toolName === 'read_sources') {
      const kind = typeof args.kind === 'string' ? args.kind : 'all';
      const query = typeof args.query === 'string' ? args.query : '';
      const suffix = query ? `, query="${query}"` : '';
      return `\n\n[TOOL] read_sources (kind=${kind}${suffix})\n`;
    }

    if (toolName === 'edit_source_passage') {
      const action = typeof args.action === 'string' ? args.action : '';
      const citationId = typeof args.citation_id === 'string' ? args.citation_id : '';
      return `\n\n[TOOL] edit_source_passage${citationId ? ` (id=${citationId}, action=${action || 'update'})` : ''}\n`;
    }

    if (toolName === 'read_file') {
      const file = typeof args.file === 'string' ? args.file : '';
      const extractText = args.extract_text === true;
      const suffix = extractText ? ', extract_text=true' : '';
      return `\n\n[TOOL] read_file${file ? ` ("${file}"${suffix})` : ''}\n`;
    }

    if (toolName === 'list') {
      const path = typeof args.path === 'string' ? args.path : '.';
      return `\n\n[TOOL] list${path ? ` ("${path}")` : ''}\n`;
    }

    if (toolName === 'read') {
      const path = typeof args.path === 'string' ? args.path : '';
      return `\n\n[TOOL] read${path ? ` ("${path}")` : ''}\n`;
    }

    if (toolName === 'write') {
      const path = typeof args.path === 'string' ? args.path : '';
      return `\n\n[TOOL] write${path ? ` ("${path}")` : ''}\n`;
    }

    if (toolName === 'edit') {
      const path = typeof args.path === 'string' ? args.path : '';
      return `\n\n[TOOL] edit${path ? ` ("${path}")` : ''}\n`;
    }

    if (toolName === 'glob') {
      const pattern = typeof args.pattern === 'string' ? args.pattern : '';
      return `\n\n[TOOL] glob${pattern ? ` ("${pattern}")` : ''}\n`;
    }

    if (toolName === 'grep') {
      const query = typeof args.query === 'string' ? args.query : '';
      return `\n\n[TOOL] grep${query ? ` ("${query}")` : ''}\n`;
    }

    if (toolName === 'terminal_create_session') {
      const projectId = typeof args.project_id === 'string' ? args.project_id : '';
      return `\n\n[TOOL] terminal_create_session${projectId ? ` ("${projectId}")` : ''}\n`;
    }

    if (toolName === 'terminal_run') {
      const command = typeof args.command === 'string' ? args.command : '';
      return `\n\n[TOOL] terminal_run${command ? ` ("${command}")` : ''}\n`;
    }

    if (toolName === 'terminal_read' || toolName === 'terminal_kill') {
      return `\n\n[TOOL] ${toolName}\n`;
    }

    if (toolName === 'need_add') {
      const title = typeof args.title === 'string' ? args.title : '';
      return `\n\n[TOOL] need_add${title ? ` ("${title}")` : ''}\n`;
    }

    if (toolName === 'strategy_generate') {
      return `\n\n[TOOL] strategy_generate\n`;
    }

    if (toolName === 'plan_create' || toolName === 'plan_list' || toolName === 'plan_get' || toolName === 'plan_update' || toolName === 'plan_delete' || toolName === 'plan_restore' || toolName === 'plan_set_active' || toolName === 'strategy_get' || toolName === 'strategy_update' || toolName === 'strategy_delete') {
      return `\n\n[TOOL] ${toolName}\n`;
    }

    return `\n\n[TOOL] ${toolName}\n`;
  };

  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
  };

  if (apiKey) {
    headers['Authorization'] = `Bearer ${apiKey}`;
  }

  // OpenRouter specific headers
  if (providerType === 'openrouter') {
    if (typeof window !== 'undefined') {
      headers['HTTP-Referer'] = window.location.origin;
    }
    headers['X-Title'] = 'Macro';
  }

  // LM Studio: Log connection attempt for debugging
  const isLocalProvider = providerType === 'lmstudio' || providerType === 'ollama';
  if (isLocalProvider) {
    console.log(`[${providerId}] Connecting to ${baseUrl}/chat/completions`);
  }

  // Build request body with optional tools
  const requestBody: Record<string, unknown> = {
    model: modelId,
    messages: messages.map((m) => ({
      role: m.role,
      content: m.content,
      ...(m.tool_calls && { tool_calls: m.tool_calls }),
      ...(m.tool_call_id && { tool_call_id: m.tool_call_id }),
    })),
    stream: true,
  };

  // Expose only explicitly allowed tools. Web search also requires provider keys.
  const tools: unknown[] = [];
  if (allowedTools.has('mark_source_passage')) {
    tools.push(MARK_SOURCE_PASSAGE_TOOL);
  }
  if (allowedTools.has('read_sources')) {
    tools.push(READ_SOURCES_TOOL);
  }
  if (allowedTools.has('edit_source_passage')) {
    tools.push(EDIT_SOURCE_PASSAGE_TOOL);
  }
  if (allowedTools.has('read_file')) {
    tools.push(READ_FILE_TOOL);
  }
  if (allowedTools.has('list')) {
    tools.push(LIST_TOOL);
  }
  if (allowedTools.has('read')) {
    tools.push(READ_WORKSPACE_TOOL);
  }
  if (allowedTools.has('write')) {
    tools.push(WRITE_WORKSPACE_TOOL);
  }
  if (allowedTools.has('edit')) {
    tools.push(EDIT_WORKSPACE_TOOL);
  }
  if (allowedTools.has('glob')) {
    tools.push(GLOB_WORKSPACE_TOOL);
  }
  if (allowedTools.has('grep')) {
    tools.push(GREP_WORKSPACE_TOOL);
  }
  if (allowedTools.has('git_status')) {
    tools.push(GIT_STATUS_TOOL);
  }
  if (allowedTools.has('git_log')) {
    tools.push(GIT_LOG_TOOL);
  }
  if (allowedTools.has('git_branch_list')) {
    tools.push(GIT_BRANCH_LIST_TOOL);
  }
  if (allowedTools.has('git_diff')) {
    tools.push(GIT_DIFF_TOOL);
  }
  if (allowedTools.has('git_get_tree')) {
    tools.push(GIT_GET_TREE_TOOL);
  }
  if (allowedTools.has('git_add')) {
    tools.push(GIT_ADD_TOOL);
  }
  if (allowedTools.has('git_commit')) {
    tools.push(GIT_COMMIT_TOOL);
  }
  if (allowedTools.has('git_checkout')) {
    tools.push(GIT_CHECKOUT_TOOL);
  }
  if (allowedTools.has('git_merge')) {
    tools.push(GIT_MERGE_TOOL);
  }
  if (allowedTools.has('git_reset')) {
    tools.push(GIT_RESET_TOOL);
  }
  if (allowedTools.has('git_stash')) {
    tools.push(GIT_STASH_TOOL);
  }
  if (allowedTools.has('terminal_create_session')) {
    tools.push(TERMINAL_CREATE_SESSION_TOOL);
  }
  if (allowedTools.has('terminal_run')) {
    tools.push(TERMINAL_RUN_TOOL);
  }
  if (allowedTools.has('terminal_read')) {
    tools.push(TERMINAL_READ_TOOL);
  }
  if (allowedTools.has('terminal_kill')) {
    tools.push(TERMINAL_KILL_TOOL);
  }
  if (
    allowedTools.has('web_search') &&
    enableWebSearch &&
    (webSearchOptions?.tavilyApiKey || webSearchOptions?.braveApiKey)
  ) {
    tools.push(WEB_SEARCH_TOOL);
  }
  if (allowedTools.has('web_fetch') && enableWebFetch) {
    tools.push(WEB_FETCH_TOOL);
  }
  if (allowedTools.has('need_add')) {
    tools.push(ADD_NEED_TOOL);
  }
  if (allowedTools.has('strategy_generate')) {
    tools.push(GENERATE_PLAN_TOOL);
  }
  if (allowedTools.has('plan_create')) {
    tools.push(CREATE_PLAN_TOOL);
  }
  if (allowedTools.has('plan_list')) {
    tools.push(LIST_PLANS_TOOL);
  }
  if (allowedTools.has('plan_get')) {
    tools.push(GET_PLAN_TOOL);
  }
  if (allowedTools.has('plan_update')) {
    tools.push(UPDATE_PLAN_TOOL);
  }
  if (allowedTools.has('plan_delete')) {
    tools.push(DELETE_PLAN_TOOL);
  }
  if (allowedTools.has('plan_restore')) {
    tools.push(RESTORE_PLAN_TOOL);
  }
  if (allowedTools.has('plan_set_active')) {
    tools.push(SET_ACTIVE_PLAN_TOOL);
  }
  if (allowedTools.has('strategy_get')) {
    tools.push(GET_STRATEGY_TOOL);
  }
  if (allowedTools.has('strategy_update')) {
    tools.push(UPDATE_STRATEGY_TOOL);
  }
  if (allowedTools.has('strategy_delete')) {
    tools.push(DELETE_STRATEGY_TOOL);
  }
  if (tools.length > 0) {
    requestBody.tools = tools;
  }

  // Storage for the entire conversation (mutated across loop turns)
  let currentMessages: StreamMessage[] = [...messages];
  let fullContent = '';
  const readEvidenceBySource = new Map<string, string>();
  const MAX_TURNS = 10;
  let turnCount = 0;

  const normalizeSourceKey = (value?: string): string =>
    (value || '')
      .trim()
      .replace(/\\/g, '/')
      .replace(/^\.\//, '')
      .toLowerCase();

  const rememberReadEvidence = (source: string, content: string) => {
    const key = normalizeSourceKey(source);
    if (!key || !content.trim()) return;
    readEvidenceBySource.set(key, content);
  };

  const rememberReadEvidenceFromWorkspaceResult = (result: string) => {
    const fileHeaderMatch = result.match(/^FILE:\s*(.+)$/m);
    if (!fileHeaderMatch) return;

    const filePath = fileHeaderMatch[1].trim();
    const separatorIndex = result.indexOf('\n\n');
    const content = separatorIndex >= 0 ? result.slice(separatorIndex + 2) : '';
    rememberReadEvidence(filePath, content);
  };

  try {
    while (turnCount < MAX_TURNS) {
      if (options.signal?.aborted) {
        onComplete(options.messages.length > 0 ? '' : 'Request cancelled');
        return;
      }

      requestBody.messages = currentMessages.map((m) => ({
        role: m.role,
        content: m.content,
        ...(m.tool_calls && { tool_calls: m.tool_calls }),
        ...(m.tool_call_id && { tool_call_id: m.tool_call_id }),
      }));

      const response = await tauriFetch(`${baseUrl}/chat/completions`, {
        method: 'POST',
        headers,
        body: JSON.stringify(requestBody),
      });

      if (!response.ok) {
        const errorText = await response.text().catch(() => 'Unknown error');
        let errorMessage = `Request failed: ${response.status}`;

        try {
          const errorJson = JSON.parse(errorText);
          errorMessage = errorJson.error?.message || errorJson.message || errorMessage;
        } catch {
          if (errorText) {
            errorMessage = errorText;
          }
        }

        if (turnCount === 0) {
          throw new Error(errorMessage);
        } else {
          const loopError = `\n\n[System: The agent loop stopped due to an API error: ${errorMessage}]`;
          fullContent += loopError;
          onToken(loopError);
          break;
        }
      }

      if (!response.body) {
        throw new Error('No response body');
      }

      // Store references for cancellation
      currentStream = response.body;
      const reader = currentStream.getReader();
      currentReader = reader;
      const decoder = new TextDecoder();
      let buffer = '';
      let isThinking = false;
      let toolCalls: ToolCall[] = [];
      let turnContent = ''; // The text generated *in this specific turn*

      const startThinking = () => {
        if (!isThinking) {
          turnContent += '<think>';
          fullContent += '<think>';
          onToken('<think>');
          isThinking = true;
        }
      };

      const endThinking = () => {
        if (isThinking) {
          turnContent += '</think>';
          fullContent += '</think>';
          onToken('</think>');
          isThinking = false;
        }
      };

      while (true) {
        // Check if the stream was cancelled
        if (options.signal?.aborted) {
          try {
            await reader.cancel();
          } catch (e) {
            // Ignore cancel errors
          }
          onComplete(options.messages.length > 0 ? '' : 'Request cancelled');
          return;
        }

        const { done, value } = await reader.read();

        if (done) {
          break;
        }

        buffer += decoder.decode(value, { stream: true });

        // Process complete SSE events
        const lines = buffer.split('\n');
        buffer = lines.pop() || ''; // Keep incomplete line in buffer

        for (const line of lines) {
          const trimmedLine = line.trim();

          if (!trimmedLine || trimmedLine === '') {
            continue;
          }

          if (trimmedLine.startsWith('data: ')) {
            const data = trimmedLine.slice(6);

            if (data === '[DONE]') {
              continue;
            }

            try {
              const parsed = JSON.parse(data);
              const delta = parsed.choices?.[0]?.delta;
              const reasoning = delta?.reasoning ?? delta?.reasoning_content;

              if (typeof reasoning === 'string' && reasoning.length > 0) {
                startThinking();
                turnContent += reasoning;
                fullContent += reasoning;
                onToken(reasoning);
              }

              // Handle tool calls
              if (delta?.tool_calls) {
                for (const toolCallDelta of delta.tool_calls) {
                  const index = toolCallDelta.index ?? 0;
                  if (!toolCalls[index]) {
                    toolCalls[index] = {
                      id: toolCallDelta.id || '',
                      type: 'function',
                      function: { name: '', arguments: '' },
                    };
                  }
                  if (toolCallDelta.id) {
                    toolCalls[index].id = toolCallDelta.id;
                  }
                  if (toolCallDelta.function?.name) {
                    toolCalls[index].function.name = toolCallDelta.function.name;
                  }
                  if (toolCallDelta.function?.arguments) {
                    toolCalls[index].function.arguments += toolCallDelta.function.arguments;
                  }
                }
              }

              if (delta?.content) {
                endThinking();
                const token = delta.content;
                turnContent += token;
                fullContent += token;
                onToken(token);
              }
            } catch (e) {
              // Skip malformed JSON - some providers send non-JSON lines
              console.debug('Failed to parse SSE data:', data);
            }
          }
        }
      }

      endThinking();

      // Parse inline JSON tool calls (e.g. from local models like Ollama)
      // <tool_call> {"name": "list", "arguments": { "path": "src" }} </tool_call>
      // Note: We use [\s\S]*? to handle multiline JSON strings
      const inlineToolRegex = /<tool_call>\s*(?=\{)([\s\S]*?)\s*<\/tool_call>/gi;
      let match;
      const inlineReplacements: { original: string, parsedName: string }[] = [];

      // We parse on a copy so we don't mess up exec indices if not replacing in place
      let contentForParsing = fullContent;
      while ((match = inlineToolRegex.exec(contentForParsing)) !== null) {
        try {
          const parsed = JSON.parse(match[1].trim());
          if (parsed.name) {
            toolCalls.push({
              id: `call_${Date.now()}_${Math.random().toString(36).substring(2, 9)}`,
              type: 'function',
              function: {
                name: parsed.name,
                arguments: typeof parsed.arguments === 'string' ? parsed.arguments : JSON.stringify(parsed.arguments || {})
              }
            });
            inlineReplacements.push({ original: match[0], parsedName: parsed.name });
          }
        } catch (e) {
          console.warn('Failed to parse inline JSON tool call', match[1]);
        }
      }

      for (const rep of inlineReplacements) {
        fullContent = fullContent.replace(rep.original, '');
      }

      // Handle tool calls if any
      const validToolCalls = toolCalls.filter(tc => tc.id && tc.function.name);
      if (validToolCalls.length > 0) {
        const toolResults: ToolResult[] = [];

        for (const toolCall of validToolCalls) {
          const toolName = toolCall.function.name;
          let toolResult = '';
          let customToolResult: string | undefined;

          try {
            const args = JSON.parse(toolCall.function.arguments);

            if (!allowedTools.has(toolName)) {
              toolResult = `Tool ${toolName} is disabled for the current mode.`;
              toolResults.push({
                tool_call_id: toolCall.id,
                content: toolResult,
              });
              continue;
            }

            const customResult = await onToolCall?.(toolName, args);
            customToolResult = typeof customResult === 'string' ? customResult : undefined;

            if (showToolTraces) {
              const toolUsageMsg = formatToolUsageLabel(toolName, args);
              fullContent += toolUsageMsg;
              onToken(toolUsageMsg);
            }

            if (toolName === 'web_search') {
              // Execute web search
              const searchResults = await webSearch(args.query, webSearchOptions);
              toolResult = formatSearchResultsAsContext(searchResults);

              // Show search indicator in chat
              if (showToolTraces) {
                const searchMsg = `\n\n🔍 **Recherche web:** "${args.query}"\n`;
                fullContent += searchMsg;
                onToken(searchMsg);
              }
            }

            if (toolName === 'web_fetch') {
              const url = typeof args.url === 'string' ? args.url : '';
              if (!url.trim()) {
                toolResult = 'Missing URL for web_fetch.';
              } else {
                const fetched = await fetchWebPage(url);
                toolResult = `TITLE: ${fetched.title}\nURL: ${fetched.url}\n\n${fetched.content}`;
              }
            }

            if (toolName === 'read_file') {
              const normalizeMatch = (value?: string) =>
                (value || '')
                  .trim()
                  .normalize('NFD')
                  .replace(/[\u0300-\u036f]/g, '')
                  .toLowerCase();

              const requestedRaw = typeof args.file === 'string' ? args.file.trim() : '';
              const requested = normalizeMatch(requestedRaw);
              const extractText = args.extract_text === true;
              const available = fileToolContext.map((f) => f.path || f.title || f.source).filter(Boolean);
              let workspaceReadAttempted = false;
              const workspaceMode = allowedTools.has('read') || allowedTools.has('list');

              if (requestedRaw && allowedTools.has('read') && onToolCall) {
                workspaceReadAttempted = true;
                const workspaceResult = await onToolCall('read', {
                  path: requestedRaw,
                  start_line: typeof args.start_line === 'number' ? args.start_line : undefined,
                  end_line: typeof args.end_line === 'number' ? args.end_line : undefined,
                });

                if (typeof workspaceResult === 'string' && workspaceResult.trim()) {
                  const isWorkspaceReadError =
                    /^Error executing read:/i.test(workspaceResult) ||
                    /^Missing\s+/i.test(workspaceResult) ||
                    /^No match found/i.test(workspaceResult) ||
                    /^File not found/i.test(workspaceResult) ||
                    /^Cannot\s+/i.test(workspaceResult);

                  if (isWorkspaceReadError) {
                    toolResult = `Error executing tool read_file: ${workspaceResult}`;
                  } else {
                    toolResult = workspaceResult;
                    rememberReadEvidenceFromWorkspaceResult(workspaceResult);
                  }
                } else {
                  toolResult = 'Error executing tool read_file: workspace read returned no content.';
                }
              }

              if (toolResult.trim()) {
                // We already have authoritative workspace output; do not fall back to context snippets.
              } else if (workspaceReadAttempted) {
                toolResult = `Error executing tool read_file: unable to read "${requestedRaw}" from workspace.`;
              } else if (workspaceMode) {
                toolResult =
                  `Error executing tool read_file: workspace read tool is unavailable for "${requestedRaw}".` +
                  ` Use the read tool directly with an explicit path.`;
              } else {
                const match = fileToolContext.find((f) => {
                  const title = normalizeMatch(f.title);
                  const source = normalizeMatch(f.source);
                  const path = normalizeMatch(f.path);
                  return (
                    requested === title ||
                    requested === source ||
                    requested === path ||
                    title.includes(requested) ||
                    source.includes(requested) ||
                    path.includes(requested)
                  );
                });

                if (!requested) {
                  toolResult = `No file provided. Available files: ${available.join(', ') || 'none'}`;
                } else if (!match) {
                  toolResult = `File not found in context: "${requestedRaw}". Available files: ${available.join(', ') || 'none'}`;
                } else {
                  const label = match.path || match.title || match.source;
                  const content = (match.snippet || '').trim();
                  const base = content
                    ? `FILE: ${label}\nSOURCE: CONTEXT_SNIPPET\n\n${content}`
                    : `FILE: ${label}\nSOURCE: CONTEXT_SNIPPET\n\nNo textual content available for this file in context.`;

                  const isDocx = /\.docx$/i.test(label || '');
                  const extractNotice =
                    extractText && isDocx
                      ? '\n\nNote: extract_text=true requested. Rich DOCX extraction is not available in this build; using available context text.'
                      : '';

                  toolResult = `${base}${extractNotice}`;
                  if (label) {
                    rememberReadEvidence(label, content);
                  }
                }
              }
            }

            if (toolName === 'mark_source_passage') {
              const rawKind = typeof args.kind === 'string' ? args.kind.trim().toLowerCase() : '';
              const kind = rawKind === 'interesting' ? 'interesting' : 'used';
              const source = typeof args.source === 'string' ? args.source : '';
              const title = typeof args.title === 'string' ? args.title : '';
              const passage = typeof args.passage === 'string' ? args.passage : '';
              const normalizedPassage = passage.trim();

              const sourceKey = normalizeSourceKey(source || title);
              const sourceEvidence = sourceKey ? readEvidenceBySource.get(sourceKey) : undefined;
              const anyEvidence = Array.from(readEvidenceBySource.values());
              const hasMatchingEvidence = normalizedPassage
                ? (
                  (sourceEvidence && sourceEvidence.includes(normalizedPassage)) ||
                  anyEvidence.some((evidence) => evidence.includes(normalizedPassage))
                )
                : false;

              if (!hasMatchingEvidence) {
                toolResult = 'Error executing tool mark_source_passage: passage is not present in previously read file content.';
              } else {
                toolResult = `Source passage marked successfully (kind=${kind}).`;
              }
            } else if (toolName === 'read_sources') {
              toolResult = customToolResult || 'No source passages available.';
            } else if (toolName === 'edit_source_passage') {
              toolResult = customToolResult || 'Source passage edit request processed.';
            } else if (customToolResult) {
              toolResult = customToolResult;
            } else if (toolName !== 'web_search' && toolName !== 'read_file' && toolName !== 'web_fetch') {
              toolResult = `Unsupported tool: ${toolName}`;
            }

            onToolResult?.(toolName, toolResult);
          } catch (e) {
            toolResult = `Error executing tool ${toolName}: ${e instanceof Error ? e.message : String(e)}`;
            onToolResult?.(toolName, toolResult);
          }

          toolResults.push({
            tool_call_id: toolCall.id,
            content: toolResult,
          });
        }

        // If we have tool results, make a follow-up request to get the final response
        if (toolResults.length > 0) {
          const hasToolErrors = toolResults.some((result) => {
            const content = result.content.trim();
            return (
              /^Error executing/i.test(content) ||
              /^Missing\s+/i.test(content) ||
              /^No match found/i.test(content) ||
              /^File not found/i.test(content) ||
              /^Cannot\s+/i.test(content)
            );
          });
          const hasFileReadResults = toolResults.some((result) => /^FILE:\s+/m.test(result.content));
          const hasWorkspaceFileReadResults = toolResults.some((result) =>
            /^FILE:\s+/m.test(result.content) && /^SOURCE:\s*WORKSPACE_FILE/m.test(result.content)
          );
          const hasContextSnippetReadResults = toolResults.some((result) =>
            /^FILE:\s+/m.test(result.content) && /^SOURCE:\s*CONTEXT_SNIPPET/m.test(result.content)
          );
          const hasWorkspaceReadCall = validToolCalls.some((call) =>
            call.function.name === 'read' || call.function.name === 'read_file' || call.function.name === 'list'
          );
          if (hasWorkspaceFileReadResults) {
            const readBlocks = toolResults
              .filter((result) => /^FILE:\s+/m.test(result.content) && /^SOURCE:\s*WORKSPACE_FILE/m.test(result.content))
              .map((result) => {
                const fileMatch = result.content.match(/^FILE:\s*(.+)$/m);
                const filePath = fileMatch?.[1]?.trim() || 'unknown-file';
                const separatorIndex = result.content.indexOf('\n\n');
                const rawContent = separatorIndex >= 0
                  ? result.content.slice(separatorIndex + 2)
                  : result.content;

                return `Contenu exact lu via l'outil pour ${filePath}:\n\n\`\`\`\n${rawContent}\n\`\`\``;
              });

            if (readBlocks.length > 0) {
              const deterministicResponse = readBlocks.join('\n\n---\n\n');
              fullContent += `\n\n${deterministicResponse}\n`;
              onToken(`\n\n${deterministicResponse}\n`);
              // We do not return here! Let the loop continue to the next turn 
              // so the AI can reason about what it just read.
            }
          }

          if (hasContextSnippetReadResults && !hasWorkspaceFileReadResults && hasWorkspaceReadCall) {
            const deterministicError = [
              'La lecture fichier ne provient pas du workspace actif (context snippet uniquement).',
              'Je refuse de synthétiser ce contenu pour éviter les hallucinations.',
              'Relance avec un chemin explicite (ex: README.md) ou vérifie le root Debug.',
            ].join('\n');

            fullContent += `\n\n${deterministicError}\n`;
            onToken(`\n\n${deterministicError}\n`);
          }

          if (hasToolErrors && hasWorkspaceReadCall) {
            const errorLines = toolResults
              .map((result) => result.content.trim())
              .filter((content) => /^Error executing/i.test(content) || /^Missing\s+/i.test(content) || /^File not found/i.test(content));

            if (errorLines.length > 0) {
              const deterministicError = [
                'La lecture workspace a échoué. Sortie brute des outils :',
                ...errorLines.map((line) => `- ${line}`),
                '',
                'Je ne peux pas déduire le contenu du fichier sans sortie de lecture valide.',
              ].join('\n');

              fullContent += `\n\n${deterministicError}\n`;
              onToken(`\n\n${deterministicError}\n`);
            }
          }

          const usedInlineTools = inlineReplacements.length > 0;

          if (usedInlineTools) {
            const textResults = toolResults.map(tr =>
              `[Tool Result for ${validToolCalls.find(tc => tc.id === tr.tool_call_id)?.function.name}]:\n${tr.content}`
            ).join('\n\n');

            currentMessages.push({
              role: 'user',
              content: `Here are the results of the tools you called:\n\n${textResults}\n\nPlease continue your task using these results.`
            });
          } else {
            currentMessages.push(...toolResults.map(tr => ({ role: 'tool' as const, content: tr.content, tool_call_id: tr.tool_call_id })));
          }

          const guardSystemMessages: StreamMessage[] = [];
          if (hasToolErrors) {
            guardSystemMessages.push({
              role: 'system',
              content:
                'One or more tool calls failed. Do not fabricate file contents or command outputs. ' +
                'State the exact failure and ask for a corrected path/context when needed.',
            });
          }
          if (hasFileReadResults) {
            guardSystemMessages.push({
              role: 'system',
              content:
                'For file analysis tasks, use ONLY the exact tool outputs provided in this conversation. ' +
                'Do not invent code symbols, structs, handlers, routes, or data not present in tool output. ' +
                'If uncertain, say that the information is not present in the file content you received.',
            });
          }

          if (guardSystemMessages.length > 0) {
            currentMessages.push(...guardSystemMessages);
          }
        }
      }

      // If no valid tool calls were made in this turn, we are done
      if (validToolCalls.length === 0) {
        break;
      }

      turnCount++;
    }

    onComplete(fullContent);
  } catch (error) {
    // Cleanup on error
    if (currentReader) {
      currentReader = null;
    }
    if (currentStream) {
      currentStream = null;
    }
    if (error instanceof Error && error.name === 'AbortError') {
      onComplete(options.messages.length > 0 ? '' : 'Request cancelled');
      return;
    }

    // Better error messages for local providers
    const err = error instanceof Error ? error : new Error(String(error));
    const isLocalProvider = options.providerType === 'lmstudio' || options.providerType === 'ollama';

    if (isLocalProvider && (err.message.includes('Failed to fetch') || err.message.includes('NetworkError') || err.message.includes('connection'))) {
      const providerName = options.providerType === 'lmstudio' ? 'LM Studio' : 'Ollama';
      onError(new Error(`Cannot connect to ${providerName}. Make sure the server is running and accessible at ${options.baseUrl}`));
      return;
    }

    onError(err);
  } finally {
    // Always cleanup references to prevent memory leaks
    currentReader = null;
    currentStream = null;
  }
}

/**
 * Non-streaming fallback for providers that don't support streaming
 */
export async function sendChatNonStreaming(options: Omit<StreamingChatOptions, 'onToken'>): Promise<string> {
  const {
    providerId,
    providerType,
    baseUrl,
    apiKey,
    modelId,
    messages,
    onComplete,
    onError,
  } = options;

  if (providerType === 'chatgpt') {
    try {
      const content = await streamChatGptTurnViaTauri({
        providerId,
        modelId,
        messages,
        signal: options.signal,
        onDelta: () => {
          // No-op for metadata generation.
        },
      });
      onComplete(content);
      return content;
    } catch (error) {
      const err = error instanceof Error ? error : new Error(String(error));
      onError(err);
      throw err;
    }
  }

  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
  };

  if (apiKey) {
    headers['Authorization'] = `Bearer ${apiKey}`;
  }

  if (providerType === 'openrouter') {
    if (typeof window !== 'undefined') {
      headers['HTTP-Referer'] = window.location.origin;
    }
    headers['X-Title'] = 'Macro';
  }

  try {
    const response = await tauriFetch(`${baseUrl}/chat/completions`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        model: modelId,
        messages: messages.map((m) => ({
          role: m.role,
          content: m.content,
        })),
        stream: false,
      }),
    });

    if (!response.ok) {
      const errorText = await response.text().catch(() => 'Unknown error');
      let errorMessage = `Request failed: ${response.status}`;

      try {
        const errorJson = JSON.parse(errorText);
        errorMessage = errorJson.error?.message || errorJson.message || errorMessage;
      } catch {
        if (errorText) {
          errorMessage = errorText;
        }
      }

      throw new Error(errorMessage);
    }

    const data = await response.json();
    const message = data.choices?.[0]?.message || {};
    const messageContent = message.content || '';
    const reasoning = message.reasoning || message.reasoning_content || '';
    const content = reasoning
      ? `<think>${reasoning}</think>${messageContent ? `\n${messageContent}` : ''}`
      : messageContent;
    onComplete(content);
    return content;
  } catch (error) {
    const err = error instanceof Error ? error : new Error(String(error));
    onError(err);
    throw err;
  }
}


