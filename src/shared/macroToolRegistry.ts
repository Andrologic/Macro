export type JsonSchema =
  | {
      type: "object";
      properties?: Record<string, JsonSchema>;
      required?: string[];
      description?: string;
      enum?: string[];
      items?: JsonSchema;
    }
  | {
      type: "array";
      items: JsonSchema;
      description?: string;
    }
  | {
      type: "string" | "number" | "boolean";
      description?: string;
      enum?: string[];
    };

export interface MacroToolRegistryEntry {
  id: string;
  description: string;
  parameters: JsonSchema;
  copilot?: {
    overridesBuiltInTool?: boolean;
  };
}

const COPILOT_SUPPORTED_TOOL_ID_SET = new Set([
  "mark_source_passage",
  "read_sources",
  "edit_source_passage",
  "question",
  "skill_activate",
  "skill_read_resource",
  "skill_run_script",
  "read_file",
  "web_fetch",
  "list",
  "read",
  "write",
  "edit",
  "delete",
  "apply_patch",
  "glob",
  "grep",
  "git_status",
  "git_log",
  "git_branch_list",
  "git_diff",
  "git_get_tree",
  "git_add",
  "git_commit",
  "git_checkout",
  "git_merge",
  "git_reset",
  "git_stash",
  "terminal_create_session",
  "terminal_run",
  "terminal_read",
  "terminal_kill",
  "need_add",
  "need_list",
  "need_get",
  "need_update",
  "strategy_generate",
  "strategy_get",
  "strategy_update",
  "task_todo_get",
  "task_todo_update",
  "task_artifact_list",
  "task_artifact_get",
  "task_artifact_put",
  "plan_create",
  "plan_list",
  "plan_get",
  "plan_update",
]);

const objectTool = (
  id: string,
  description: string,
  parameters: JsonSchema,
): MacroToolRegistryEntry => ({
  id,
  description,
  parameters,
});

const planNodeTodoSchema = (description?: string): JsonSchema => ({
  type: "array",
  description:
    description ||
    "Task-local implementation checklist. Choose the natural number of todos for the task; do not pad to a fixed count.",
  items: {
    type: "object",
    properties: {
      id: { type: "string" },
      title: { type: "string" },
      description: { type: "string" },
      status: {
        type: "string",
        enum: ["pending", "in-progress", "done"],
      },
    },
    required: ["title"],
  },
});

const planNodeArtifactContractSchema = (description?: string): JsonSchema => ({
  type: "array",
  description:
    description ||
    "Required durable handoff artifacts this node must produce for dependent tasks. Declare only critical handoffs; omit artifactContracts when no durable handoff is needed.",
  items: {
    type: "object",
    properties: {
      id: {
        type: "string",
        description: "Stable artifact contract id, for example audit-findings or api-contract.",
      },
      title: { type: "string" },
      kind: {
        type: "string",
        description: "Short artifact category such as audit, migration_map, api_contract, risk_register, note.",
      },
      description: { type: "string" },
    },
    required: ["id", "title", "kind"],
  },
});

const copilotBuiltInOverrideTool = (
  id: string,
  description: string,
  parameters: JsonSchema,
): MacroToolRegistryEntry => ({
  ...objectTool(id, description, parameters),
  copilot: {
    overridesBuiltInTool: true,
  },
});

export const MACRO_TOOL_REGISTRY = [
  objectTool(
    "web_search",
    "Search the web for current information. Use this when you need up-to-date information about any topic.",
    {
      type: "object",
      properties: {
        query: {
          type: "string",
          description: "The search query to look up",
        },
      },
      required: ["query"],
    },
  ),
  copilotBuiltInOverrideTool("web_fetch", "Fetch and read the content of a specific URL.", {
    type: "object",
    properties: {
      url: {
        type: "string",
        description: "URL to fetch and read",
      },
    },
    required: ["url"],
  }),
  objectTool(
    "question",
    "Ask the user for a blocking structured clarification. Use at most one question tool call per assistant turn, and include 1 to 5 sequential questions with exactly 3 suggested choices each.",
    {
      type: "object",
      properties: {
        intro: {
          type: "string",
          description:
            "Optional short intro shown above the questionnaire in the chat footer.",
        },
        questions: {
          type: "array",
          description:
            "Sequential questions to ask the user. Each question must provide exactly 3 suggested choices.",
          items: {
            type: "object",
            properties: {
              id: {
                type: "string",
                description: "Stable identifier for this question.",
              },
              prompt: {
                type: "string",
                description: "Question text shown to the user.",
              },
              choices: {
                type: "array",
                description:
                  "Exactly 3 suggested answers ordered by preference.",
                items: {
                  type: "string",
                },
              },
              free_text_placeholder: {
                type: "string",
                description:
                  "Optional placeholder for the inline free-text answer field.",
              },
            },
            required: ["id", "prompt", "choices"],
          },
        },
      },
      required: ["questions"],
    },
  ),
  objectTool(
    "mark_source_passage",
    'Store important source passages. Use kind="interesting" for notable excerpts and kind="used" for excerpts directly used in the final answer.',
    {
      type: "object",
      properties: {
        title: {
          type: "string",
          description: "Short title of the passage.",
        },
        passage: {
          type: "string",
          description: "Important excerpt to save.",
        },
        kind: {
          type: "string",
          enum: ["interesting", "used"],
          description:
            "Classification of the passage: interesting while analyzing, or used in the final answer.",
        },
        reason: {
          type: "string",
          description:
            "Optional short reason describing why this passage matters.",
        },
        source: {
          type: "string",
          description: "Source label such as filename or site/domain.",
        },
        url: {
          type: "string",
          description: "URL of the source when available.",
        },
      },
      required: ["title", "passage"],
    },
  ),
  objectTool(
    "skill_activate",
    "Load the full instructions for an enabled Macro skill. Use this when the user's task matches a listed skill or the user explicitly references a skill with $skill-name.",
    {
      type: "object",
      properties: {
        skill_id: {
          type: "string",
          description: "Exact skill id from the available Macro skills catalog.",
        },
      },
      required: ["skill_id"],
    },
  ),
  objectTool(
    "skill_read_resource",
    "Read a text resource bundled with an enabled Macro skill. Only references/ and assets/ paths are allowed.",
    {
      type: "object",
      properties: {
        skill_id: {
          type: "string",
          description: "Exact skill id from the available Macro skills catalog.",
        },
        path: {
          type: "string",
          description: "Relative path under references/ or assets/.",
        },
      },
      required: ["skill_id", "path"],
    },
  ),
  objectTool(
    "skill_run_script",
    "Run a script bundled with a trusted enabled Macro skill. This requires skill trust, scripts enabled, and may require user approval.",
    {
      type: "object",
      properties: {
        skill_id: {
          type: "string",
          description: "Exact skill id from the available Macro skills catalog.",
        },
        script_path: {
          type: "string",
          description: "Relative path under scripts/.",
        },
        args: {
          type: "array",
          description: "String command-line arguments to pass to the script.",
          items: { type: "string" },
        },
        timeout_ms: {
          type: "number",
          description: "Optional timeout in milliseconds, capped by Macro.",
        },
        allow_workspace: {
          type: "boolean",
          description: "Set true only when the script must run with the current workspace as cwd.",
        },
      },
      required: ["skill_id", "script_path"],
    },
  ),
  objectTool(
    "read_sources",
    "Read saved source passages from the current conversation. Can filter by kind and query.",
    {
      type: "object",
      properties: {
        kind: {
          type: "string",
          enum: ["all", "interesting", "used"],
          description: "Optional filter by source passage kind.",
        },
        query: {
          type: "string",
          description:
            "Optional keyword filter over title, passage, source, url, and reason.",
        },
        limit: {
          type: "number",
          description: "Optional maximum number of passages to return (1-50).",
        },
        include_snippet: {
          type: "boolean",
          description:
            "Include full passage snippets in results. Defaults to true.",
        },
      },
      required: [],
    },
  ),
  objectTool(
    "edit_source_passage",
    "Update, reclassify, or delete a saved source passage by citation_id.",
    {
      type: "object",
      properties: {
        citation_id: {
          type: "string",
          description: "ID of the source citation to modify.",
        },
        action: {
          type: "string",
          enum: ["update", "reclassify", "delete"],
          description: "Type of modification to apply.",
        },
        title: {
          type: "string",
          description: 'Updated title for action="update".',
        },
        passage: {
          type: "string",
          description: 'Updated passage text for action="update".',
        },
        source: {
          type: "string",
          description: 'Updated source label for action="update".',
        },
        url: {
          type: "string",
          description: 'Updated URL for action="update".',
        },
        reason: {
          type: "string",
          description: 'Updated or new reason for action="update".',
        },
        kind: {
          type: "string",
          enum: ["interesting", "used"],
          description:
            'Required for action="reclassify". Optional for action="update".',
        },
      },
      required: ["citation_id", "action"],
    },
  ),
  copilotBuiltInOverrideTool(
    "read_file",
    "Read a file already attached in the conversation context. Use this when asked to analyze or inspect a file.",
    {
      type: "object",
      properties: {
        file: {
          type: "string",
          description: "File name/path/source to read (example: hotas.pr0).",
        },
        extract_text: {
          type: "boolean",
          description:
            "Optional hint to request text extraction for binary-like formats (e.g. .docx).",
        },
      },
      required: ["file"],
    },
  ),
  copilotBuiltInOverrideTool(
    "list",
    "List files and directories under a path in the local workspace. In a global project, the visible root can be virtual and contain only subproject mounts such as api/ or web/.",
    {
      type: "object",
      properties: {
        path: {
          type: "string",
          description:
            "Directory path to list. Defaults to the current execution workspace root for this conversation.",
        },
        project_id: {
          type: "string",
          description:
            "Optional subproject identifier when you want to force which subproject to use.",
        },
        recursive: {
          type: "boolean",
          description: "Whether to list recursively.",
        },
        include_hidden: {
          type: "boolean",
          description: "Include hidden files/folders.",
        },
        max_depth: {
          type: "number",
          description: "Maximum recursion depth when recursive=true.",
        },
      },
      required: [],
    },
  ),
  copilotBuiltInOverrideTool(
    "read",
    "Read a file from the local execution workspace by path. In a virtual global project root, prefer paths like api/src/server.ts or pass project_id.",
    {
      type: "object",
      properties: {
        path: { type: "string", description: "Path of the file to read." },
        project_id: {
          type: "string",
          description:
            "Optional subproject identifier when you want to force which subproject to use.",
        },
        start_line: {
          type: "number",
          description: "Optional 1-based start line.",
        },
        end_line: { type: "number", description: "Optional 1-based end line." },
      },
      required: ["path"],
    },
  ),
  copilotBuiltInOverrideTool(
    "write",
    "Create or overwrite a file in the current execution workspace with full content. In a virtual global project root, pass project_id or use a mount-prefixed path such as api/src/server.ts.",
    {
      type: "object",
      properties: {
        path: { type: "string", description: "Path of the file to write." },
        project_id: {
          type: "string",
          description:
            "Optional subproject identifier when you want to force which subproject to use.",
        },
        content: { type: "string", description: "Final file content." },
        create_dirs: {
          type: "boolean",
          description: "Create missing parent directories.",
        },
      },
      required: ["path", "content"],
    },
  ),
  copilotBuiltInOverrideTool(
    "edit",
    "Edit a file in the current execution workspace by replacing exact text. In a virtual global project root, pass project_id or use a mount-prefixed path such as api/src/server.ts.",
    {
      type: "object",
      properties: {
        path: { type: "string", description: "Path of the file to edit." },
        project_id: {
          type: "string",
          description:
            "Optional subproject identifier when you want to force which subproject to use.",
        },
        old_text: { type: "string", description: "Exact text to replace." },
        new_text: { type: "string", description: "Replacement text." },
        replace_all: {
          type: "boolean",
          description: "Replace all matches (default false = first only).",
        },
      },
      required: ["path", "old_text", "new_text"],
    },
  ),
  copilotBuiltInOverrideTool(
    "delete",
    "Delete a file in the current execution workspace. In a virtual global project root, pass project_id or use a mount-prefixed path such as api/src/server.ts. This tool only supports files, not directories.",
    {
      type: "object",
      properties: {
        path: { type: "string", description: "Path of the file to delete." },
        project_id: {
          type: "string",
          description:
            "Optional subproject identifier when you want to force which subproject to use.",
        },
      },
      required: ["path"],
    },
  ),
  copilotBuiltInOverrideTool(
    "apply_patch",
    "Apply an atomic multi-file patch in the current execution workspace. Use the Macro patch format: *** Begin Patch, then one or more file sections using *** Add File:, *** Update File:, or *** Delete File:, then *** End Patch. Prefer this for coordinated edits and keep paths relative to the execution workspace.",
    {
      type: "object",
      properties: {
        project_id: {
          type: "string",
          description:
            "Optional subproject identifier when you want to force which subproject to use.",
        },
        patch_text: {
          type: "string",
          description:
            "Patch text in Macro apply_patch format with add/update/delete file sections.",
        },
      },
      required: ["patch_text"],
    },
  ),
  copilotBuiltInOverrideTool(
    "glob",
    "Find files in the current execution workspace matching a glob pattern. In a virtual global project root, results are returned as mountName/path such as api/src/server.ts.",
    {
      type: "object",
      properties: {
        pattern: { type: "string", description: "Glob pattern." },
        project_id: {
          type: "string",
          description:
            "Optional subproject identifier when you want to force which subproject to use.",
        },
        include_hidden: {
          type: "boolean",
          description: "Include hidden files/folders.",
        },
      },
      required: ["pattern"],
    },
  ),
  copilotBuiltInOverrideTool(
    "grep",
    "Search text in files under the current execution workspace. In a virtual global project root, results are returned as mountName/path such as api/src/server.ts.",
    {
      type: "object",
      properties: {
        query: { type: "string", description: "Text or regex to search for." },
        project_id: {
          type: "string",
          description:
            "Optional subproject identifier when you want to force which subproject to use.",
        },
        is_regexp: {
          type: "boolean",
          description: "Treat query as regex when true.",
        },
        include_pattern: {
          type: "string",
          description: "Optional file glob filter.",
        },
        include_hidden: {
          type: "boolean",
          description: "Include hidden files/folders.",
        },
        max_results: {
          type: "number",
          description: "Maximum result rows to return.",
        },
      },
      required: ["query"],
    },
  ),
  objectTool(
    "git_status",
    "Get git status for exactly one subproject repository context. There is no git status at the virtual global root.",
    {
      type: "object",
      properties: {
        project_id: {
          type: "string",
          description:
            "Optional subproject identifier when you want to force which subproject to use.",
        },
        repo_path: {
          type: "string",
          description:
            "Optional repository path override. In a virtual global root, you can use mount-prefixed values such as api or api/src.",
        },
      },
      required: [],
    },
  ),
  objectTool("git_log", "Get git commit history.", {
    type: "object",
    properties: {
      repo_path: { type: "string" },
      project_id: { type: "string" },
      limit: { type: "number" },
      branch: { type: "string" },
    },
    required: [],
  }),
  objectTool("git_branch_list", "List local and remote branches.", {
    type: "object",
    properties: {
      repo_path: { type: "string" },
      project_id: { type: "string" },
    },
    required: [],
  }),
  objectTool("git_diff", "Generate repository diff.", {
    type: "object",
    properties: {
      repo_path: { type: "string" },
      project_id: { type: "string" },
      base: { type: "string" },
      head: { type: "string" },
      context_lines: { type: "number" },
      ignore_whitespace: { type: "boolean" },
      paths: { type: "array", items: { type: "string" } },
    },
    required: [],
  }),
  objectTool(
    "git_get_tree",
    "Get predicted git tree for current branch/repository.",
    {
      type: "object",
      properties: {
        repo_path: { type: "string" },
        project_id: { type: "string" },
        branch: { type: "string" },
      },
      required: [],
    },
  ),
  objectTool("git_add", "Stage files in the repository index.", {
    type: "object",
    properties: {
      repo_path: { type: "string" },
      project_id: { type: "string" },
      paths: { type: "array", items: { type: "string" } },
    },
    required: [],
  }),
  objectTool("git_commit", "Create commit in repository. The message must follow Conventional Commits: type: subject.", {
    type: "object",
    properties: {
      repo_path: { type: "string" },
      project_id: { type: "string" },
      message: { type: "string" },
      stage_all: { type: "boolean" },
    },
    required: ["message"],
  }),
  objectTool(
    "git_checkout",
    "Checkout branch or commit, optionally creating branch.",
    {
      type: "object",
      properties: {
        repo_path: { type: "string" },
        project_id: { type: "string" },
        branch_or_commit: { type: "string" },
        create: { type: "boolean" },
      },
      required: ["branch_or_commit"],
    },
  ),
  objectTool(
    "git_merge",
    "Merge a source branch into a target branch for exactly one subproject repository context.",
    {
      type: "object",
      properties: {
        repo_path: { type: "string" },
        project_id: { type: "string" },
        branch_name: { type: "string" },
        into_branch: { type: "string" },
      },
      required: ["branch_name", "into_branch"],
    },
  ),
  objectTool(
    "git_reset",
    "Reset repository to commit/HEAD in soft/mixed/hard mode.",
    {
      type: "object",
      properties: {
        repo_path: { type: "string" },
        project_id: { type: "string" },
        mode: { type: "string", enum: ["soft", "mixed", "hard"] },
        commit: { type: "string" },
        confirm: { type: "boolean" },
      },
      required: ["mode"],
    },
  ),
  objectTool("git_stash", "Stash local changes.", {
    type: "object",
    properties: {
      repo_path: { type: "string" },
      project_id: { type: "string" },
      message: { type: "string" },
    },
    required: [],
  }),
  objectTool(
    "terminal_create_session",
    "Create a terminal session bound to exactly one subproject. project_id is required. There is no terminal at the virtual global root.",
    {
      type: "object",
      properties: {
        project_id: {
          type: "string",
          description: "Required subproject identifier.",
        },
        cwd: {
          type: "string",
          description:
            "Optional directory under the selected subproject or worktree.",
        },
      },
      required: ["project_id"],
    },
  ),
  objectTool(
    "terminal_run",
    "Run a shell command inside an existing terminal session.",
    {
      type: "object",
      properties: {
        session_id: {
          type: "string",
          description:
            "Terminal session identifier returned by terminal_create_session.",
        },
        command: { type: "string", description: "Shell command to execute." },
        timeout_ms: {
          type: "number",
          description: "Optional timeout in milliseconds.",
        },
      },
      required: ["session_id", "command"],
    },
  ),
  objectTool(
    "terminal_read",
    "Read the latest output and status from an existing terminal session.",
    {
      type: "object",
      properties: {
        session_id: {
          type: "string",
          description:
            "Terminal session identifier returned by terminal_create_session.",
        },
      },
      required: ["session_id"],
    },
  ),
  objectTool(
    "terminal_kill",
    "Kill the active process in an existing terminal session.",
    {
      type: "object",
      properties: {
        session_id: {
          type: "string",
          description:
            "Terminal session identifier returned by terminal_create_session.",
        },
      },
      required: ["session_id"],
    },
  ),
  objectTool(
    "need_add",
    "Add a structured user or system need for the project. Use this during the Architect phase to gather requirements.",
    {
      type: "object",
      properties: {
        title: { type: "string", description: "Short title of the need." },
        description: {
          type: "string",
          description: "Detailed description of what is needed.",
        },
        target_branch: {
          type: "string",
          description:
            "Optional target code branch for the active plan context.",
        },
        category: {
          type: "string",
          enum: [
            "functional",
            "technical",
            "ux",
            "performance",
            "security",
            "data",
            "business",
            "other",
          ],
          description: "Category of the need.",
        },
        priority: {
          type: "string",
          enum: ["low", "medium", "high"],
          description: "Priority level.",
        },
        tags: {
          type: "array",
          items: { type: "string" },
          description: "Keywords or tags.",
        },
      },
      required: ["title", "description", "category", "priority"],
    },
  ),
  objectTool(
    "need_list",
    "List a compact index of needs for the active Architect plan (id, title, priority only). Use need_get for full details of a single need. Supports filtering by status, category, priority, or tag.",
    {
      type: "object",
      properties: {
        status: {
          type: "string",
          enum: ["identified", "refined", "validated"],
          description: "Optional need status filter.",
        },
        category: {
          type: "string",
          enum: [
            "functional",
            "technical",
            "ux",
            "performance",
            "security",
            "data",
            "business",
            "other",
          ],
          description: "Optional need category filter.",
        },
        priority: {
          type: "string",
          enum: ["low", "medium", "high"],
          description: "Optional need priority filter.",
        },
        tag: {
          type: "string",
          description: "Optional tag filter.",
        },
      },
      required: [],
    },
  ),
  objectTool(
    "need_get",
    "Load the full details of a single need from the active Architect plan by need_id.",
    {
      type: "object",
      properties: {
        need_id: {
          type: "string",
          description: "Need identifier within the active plan.",
        },
      },
      required: ["need_id"],
    },
  ),
  objectTool(
    "need_update",
    "Update part of a need on the active Architect plan. Only the provided fields are changed.",
    {
      type: "object",
      properties: {
        need_id: {
          type: "string",
          description: "Need identifier within the active plan.",
        },
        title: { type: "string", description: "Updated need title." },
        description: {
          type: "string",
          description: "Updated need description.",
        },
        category: {
          type: "string",
          enum: [
            "functional",
            "technical",
            "ux",
            "performance",
            "security",
            "data",
            "business",
            "other",
          ],
          description: "Updated need category.",
        },
        priority: {
          type: "string",
          enum: ["low", "medium", "high"],
          description: "Updated need priority.",
        },
        status: {
          type: "string",
          enum: ["identified", "refined", "validated"],
          description: "Updated need status.",
        },
        tags: {
          type: "array",
          items: { type: "string" },
          description: "Replacement tag list for the need.",
        },
      },
      required: ["need_id"],
    },
  ),
  objectTool(
    "need_delete",
    "Delete a need from the active Architect plan. Requires confirm=true.",
    {
      type: "object",
      properties: {
        need_id: {
          type: "string",
          description: "Need identifier within the active plan.",
        },
        confirm: {
          type: "boolean",
          description: "Must be true to confirm the deletion.",
        },
      },
      required: ["need_id", "confirm"],
    },
  ),
  objectTool(
    "strategy_generate",
    "Generate a structured strategy for the active plan based on collected needs. Propose logical slugs (`plan_slug` and a unique per-node `featureSlug`) rather than raw git branch names. Use dependencies for sequential work; concrete branch names are rendered later from each subproject Git workflow profile. Add concrete per-node todos for the implementation checklist, and declare artifactContracts only when a task must hand off critical durable knowledge such as audit findings, a migration map, an API contract, or a risk register. Do not add artifactContracts to every node; Implement agents can create opportunistic artifacts later. Do not add a finalization node: Macro adds the synthetic plan-finalization task after terminal nodes.",
    {
      type: "object",
      properties: {
        plan_id: {
          type: "string",
          description: "Optional existing plan ID to update.",
        },
        plan_slug: {
          type: "string",
          description:
            "Optional logical plan slug. This can change only while the active plan is still a mutable draft.",
        },
        plan_title: {
          type: "string",
          description:
            "Optional secondary plan label to persist. For legacy plans this remains a title alias.",
        },
        plan_description: {
          type: "string",
          description:
            "Optional plan description for persistence in @macro metadata.",
        },
        target_branch: {
          type: "string",
          description: "Code branch this plan is associated with.",
        },
        nodes: {
          type: "array",
          items: {
            type: "object",
            properties: {
              title: { type: "string" },
              description: { type: "string" },
              type: {
                type: "string",
                enum: ["spec", "feature", "task", "milestone"],
              },
              projectId: {
                type: "string",
                description:
                  "Optional editable subproject id for this node. If omitted, the node uses the active plan's editable projectIds.",
              },
              project_id: {
                type: "string",
                description:
                  "Snake_case alias for projectId.",
              },
              projectIds: {
                type: "array",
                items: { type: "string" },
                description:
                  "Optional editable subproject ids for this node. Must be a subset of the active plan's projectIds; context_project_ids are read-only context and cannot receive executable branches.",
              },
              project_ids: {
                type: "array",
                items: { type: "string" },
                description:
                  "Snake_case alias for projectIds.",
              },
              branchType: {
                type: "string",
                enum: ["feature"],
                description:
                  "Legacy compatibility field. New plan work branches must use feature; prefer featureSlug.",
              },
              featureSlug: {
                type: "string",
                description:
                  "Unique logical task branch slug for this node within the current plan.",
              },
              feature_slug: {
                type: "string",
                description: "Legacy snake_case alias for featureSlug.",
              },
              branchSlug: {
                type: "string",
                description:
                  "Legacy alias for featureSlug.",
              },
              assignedBranch: {
                type: "string",
                description:
                  "Legacy fallback branch label. Avoid raw git branch names in new payloads.",
              },
              dependencies: {
                type: "array",
                items: { type: "string" },
                description: "Titles of nodes this one depends on.",
              },
              todos: planNodeTodoSchema(
                "Concrete implementation checklist for this node. Choose the natural number of todos for the task: small tasks may need 1-2, larger tasks may need more. Do not pad every task to the same count.",
              ),
              artifactContracts: planNodeArtifactContractSchema(
                "Required expected handoff artifacts this node must produce for dependent tasks. Declare only critical handoffs; omit this field when no durable handoff is needed.",
              ),
              artifact_contracts: planNodeArtifactContractSchema(
                "Snake_case alias for artifactContracts.",
              ),
            },
            required: ["title", "type"],
          },
          description: "List of plan nodes representing the tasks to be done.",
        },
      },
      required: ["nodes"],
    },
  ),
  objectTool(
    "plan_create",
    "Create a new Architect plan stored under the @macro branch metadata for a target code branch. New plans are created immediately with a generated identifier; title is optional and treated as an initial secondary label.",
    {
      type: "object",
      properties: {
        label: {
          type: "string",
          description: "Optional secondary plan label.",
        },
        title: {
          type: "string",
          description: "Legacy alias for label. Optional.",
        },
        description: { type: "string" },
        project_ids: {
          type: "array",
          items: { type: "string" },
          description:
            "Optional actionable repository ids for the new draft plan. Defaults to the current Architect scope.",
        },
        context_project_ids: {
          type: "array",
          items: { type: "string" },
          description:
            "Optional read/context repository ids for the new draft plan.",
        },
        git_flow: {
          type: "object",
          description:
            "Optional Git workflow metadata for typed Release/Hotfix/Bugfix draft plans.",
        },
        target_branch: {
          type: "string",
          description:
            "Code branch this plan belongs to (e.g. develop, feature/auth).",
        },
        status: {
          type: "string",
          enum: [
            "draft",
            "validated",
            "in_progress",
            "completed",
            "archived",
            "deleted",
          ],
        },
        set_active: { type: "boolean" },
      },
      required: [],
    },
  ),
  objectTool(
    "plan_list",
    "List plans for a code branch in the @macro branch metadata.",
    {
      type: "object",
      properties: {
        target_branch: { type: "string" },
        include_deleted: { type: "boolean" },
        include_archived: { type: "boolean" },
      },
      required: [],
    },
  ),
  objectTool(
    "plan_get",
    "Read a specific plan and its nodes from @macro metadata.",
    {
      type: "object",
      properties: {
        plan_id: { type: "string" },
        target_branch: { type: "string" },
      },
      required: ["plan_id"],
    },
  ),
  objectTool(
    "plan_update",
    "Update safe plan metadata such as display label/title alias or description. Draft plans can also update slug, scope, and Git workflow metadata. The technical plan id never changes, and the logical slug becomes immutable once the plan is real.",
    {
      type: "object",
      properties: {
        plan_id: { type: "string" },
        slug: {
          type: "string",
          description:
            "Optional logical plan slug. Allowed only while the plan is still a mutable draft.",
        },
        plan_slug: {
          type: "string",
          description: "Legacy alias for slug.",
        },
        label: {
          type: "string",
          description: "Optional secondary label for the plan.",
        },
        title: {
          type: "string",
          description:
            "Legacy alias. For new plans this updates the optional secondary label.",
        },
        description: { type: "string" },
        project_ids: {
          type: "array",
          items: { type: "string" },
          description:
            "Draft-only actionable repository ids confirmed for the plan.",
        },
        context_project_ids: {
          type: "array",
          items: { type: "string" },
          description:
            "Draft-only read/context repository ids confirmed for the plan.",
        },
        git_flow: {
          type: "object",
          description:
            "Draft-only Git workflow metadata for typed Release/Hotfix/Bugfix plans, including per-project versions and slugs.",
        },
        target_branch: { type: "string" },
      },
      required: ["plan_id"],
    },
  ),
  objectTool(
    "plan_delete",
    "Delete a plan. Soft delete by default; hard delete when hard_delete=true.",
    {
      type: "object",
      properties: {
        plan_id: { type: "string" },
        target_branch: { type: "string" },
        hard_delete: { type: "boolean" },
      },
      required: ["plan_id"],
    },
  ),
  objectTool(
    "plan_restore",
    "Restore a soft-deleted plan back to draft status.",
    {
      type: "object",
      properties: {
        plan_id: { type: "string" },
        target_branch: { type: "string" },
      },
      required: ["plan_id"],
    },
  ),
  objectTool(
    "plan_set_active",
    "Set active plan for a target code branch in @macro metadata.",
    {
      type: "object",
      properties: {
        plan_id: { type: "string" },
        target_branch: { type: "string" },
      },
      required: ["plan_id"],
    },
  ),
  objectTool(
    "strategy_get",
    "Read the current strategy (nodes and branches) for the active plan.",
    {
      type: "object",
      properties: {
        target_branch: { type: "string" },
      },
      required: [],
    },
  ),
  objectTool(
    "task_todo_get",
    "Read the todo checklist for the current Implement task or an allowed Architect task.",
    {
      type: "object",
      properties: {
        task_id: {
          type: "string",
          description:
            "Optional task id. Defaults to the currently selected Implement task.",
        },
      },
      required: [],
    },
  ),
  objectTool(
    "task_todo_update",
    "Modify the todo checklist for the current Implement task or an allowed Architect task. Use this to keep task progress explicit before completing the task.",
    {
      type: "object",
      properties: {
        task_id: {
          type: "string",
          description:
            "Optional task id. Defaults to the currently selected Implement task.",
        },
        operations: {
          type: "array",
          description: "Todo patch operations applied in order.",
          items: {
            type: "object",
            properties: {
              action: {
                type: "string",
                enum: ["add", "update", "remove", "reorder", "set_status"],
              },
              todo_id: { type: "string" },
              title: { type: "string" },
              description: { type: "string" },
              status: {
                type: "string",
                enum: ["pending", "in-progress", "done"],
              },
              after_todo_id: {
                type: "string",
                description:
                  "For reorder, move todo_id after this todo id. Omit or pass an empty string to move to the top.",
              },
            },
            required: ["action"],
          },
        },
      },
      required: ["operations"],
    },
  ),
  objectTool(
    "task_artifact_list",
    "List durable task artifacts visible from the current Implement task. Returns metadata only; use task_artifact_get for full content.",
    {
      type: "object",
      properties: {
        task_id: {
          type: "string",
          description:
            "Optional task id. Defaults to the currently selected Implement task.",
        },
        include_inherited: {
          type: "boolean",
          description:
            "Include artifacts from transitive dependency tasks. Defaults to true.",
        },
        include_own: {
          type: "boolean",
          description:
            "Include artifacts produced by this task. Defaults to true.",
        },
      },
      required: [],
    },
  ),
  objectTool(
    "task_artifact_get",
    "Read the full content of a durable task artifact that is visible from the current Implement task.",
    {
      type: "object",
      properties: {
        task_id: {
          type: "string",
          description:
            "Optional task id. Defaults to the currently selected Implement task.",
        },
        artifact_id: {
          type: "string",
          description: "Artifact id from task_artifact_list.",
        },
      },
      required: ["artifact_id"],
    },
  ),
  objectTool(
    "task_artifact_put",
    "Create or replace a durable artifact for the current Architect task. Use this for findings, maps, contracts, or decisions that dependent tasks need later.",
    {
      type: "object",
      properties: {
        task_id: {
          type: "string",
          description:
            "Optional current task id. Writes are rejected for any other task.",
        },
        artifact_id: {
          type: "string",
          description:
            "Optional stable artifact id. If omitted, Macro derives one from contract_id or title.",
        },
        contract_id: {
          type: "string",
          description:
            "Optional artifact contract id declared on this strategy node.",
        },
        supersedes_artifact_id: {
          type: "string",
          description:
            "Optional visible artifact id this artifact replaces. Use this when modifying an inherited artifact; Macro keeps the parent artifact intact.",
        },
        kind: {
          type: "string",
          description:
            "Short artifact category such as audit, migration_map, api_contract, risk_register, note.",
        },
        title: { type: "string" },
        summary: {
          type: "string",
          description:
            "Brief summary shown to dependent tasks before they fetch full content.",
        },
        content_type: {
          type: "string",
          enum: ["markdown", "json", "text"],
        },
        content: {
          type: "string",
          description:
            "Full artifact content. V1 supports Markdown, JSON, or plain text.",
        },
      },
      required: ["title", "summary", "content"],
    },
  ),
  objectTool(
    "strategy_update",
    "Modify strategy for the active plan. Prefer logical slugs (`plan_slug` and a unique per-node `featureSlug`) when creating or updating nodes; use dependencies for sequential work, keep assignedBranch as a legacy fallback only, keep per-node todos current, and declare artifactContracts only for critical required task handoffs. Do not add artifactContracts to every node; Implement agents can create opportunistic artifacts later. Do not add a finalization node: Macro adds the synthetic plan-finalization task after terminal nodes.",
    {
      type: "object",
      properties: {
        target_branch: { type: "string" },
        plan_slug: {
          type: "string",
          description:
            "Optional logical plan slug. Allowed only while the active plan is still a mutable draft.",
        },
        replace: {
          type: "boolean",
          description: "If true, replace strategy with provided nodes.",
        },
        nodes: {
          type: "array",
          items: {
            type: "object",
            properties: {
              id: { type: "string" },
              title: { type: "string" },
              description: { type: "string" },
              type: {
                type: "string",
                enum: ["spec", "feature", "task", "milestone"],
              },
              branchType: {
                type: "string",
                enum: ["feature"],
                description:
                  "Legacy compatibility field. New plan work branches must use feature; prefer featureSlug.",
              },
              featureSlug: {
                type: "string",
                description:
                  "Unique logical task branch slug for this node within the active plan.",
              },
              feature_slug: {
                type: "string",
                description: "Legacy snake_case alias for featureSlug.",
              },
              branchSlug: {
                type: "string",
                description: "Legacy alias for featureSlug.",
              },
              assignedBranch: { type: "string" },
              status: {
                type: "string",
                enum: ["pending", "in-progress", "completed", "blocked"],
              },
              dependencies: { type: "array", items: { type: "string" } },
              todos: planNodeTodoSchema(),
              artifactContracts: planNodeArtifactContractSchema(),
              artifact_contracts: planNodeArtifactContractSchema(
                "Snake_case alias for artifactContracts.",
              ),
            },
            required: ["title", "type"],
          },
        },
        operations: {
          type: "array",
          description: "Patch operations applied in order.",
          items: {
            type: "object",
            properties: {
              action: { type: "string", enum: ["add", "update", "remove"] },
              node_id: { type: "string" },
              title: { type: "string" },
              description: { type: "string" },
              type: {
                type: "string",
                enum: ["spec", "feature", "task", "milestone"],
              },
              branchType: {
                type: "string",
                enum: ["feature"],
                description:
                  "Legacy compatibility field. New plan work branches must use feature; prefer featureSlug.",
              },
              featureSlug: {
                type: "string",
                description:
                  "Unique logical task branch slug for this node within the active plan.",
              },
              feature_slug: {
                type: "string",
                description: "Legacy snake_case alias for featureSlug.",
              },
              branchSlug: {
                type: "string",
                description: "Legacy alias for featureSlug.",
              },
              assignedBranch: { type: "string" },
              status: {
                type: "string",
                enum: ["pending", "in-progress", "completed", "blocked"],
              },
              dependencies: { type: "array", items: { type: "string" } },
              todos: planNodeTodoSchema(),
              artifactContracts: planNodeArtifactContractSchema(),
              artifact_contracts: planNodeArtifactContractSchema(
                "Snake_case alias for artifactContracts.",
              ),
            },
            required: ["action"],
          },
        },
      },
      required: [],
    },
  ),
  objectTool(
    "strategy_delete",
    "Delete all strategy nodes and predicted branches for the active plan. Requires confirm=true.",
    {
      type: "object",
      properties: {
        target_branch: { type: "string" },
        confirm: { type: "boolean" },
      },
      required: ["confirm"],
    },
  ),
] satisfies MacroToolRegistryEntry[];

const registryMap = new Map(
  MACRO_TOOL_REGISTRY.map((entry) => [entry.id, entry] as const),
);

export const getMacroToolRegistryEntry = (
  toolId: string,
): MacroToolRegistryEntry | undefined => registryMap.get(toolId);

export const requireMacroToolRegistryEntry = (
  toolId: string,
): MacroToolRegistryEntry => {
  const entry = registryMap.get(toolId);
  if (!entry) {
    throw new Error(`Unknown Macro tool registry entry: ${toolId}`);
  }
  return entry;
};

export const isMacroToolSupportedByCopilot = (toolId: string): boolean =>
  COPILOT_SUPPORTED_TOOL_ID_SET.has(toolId);

export const isMacroToolCopilotBuiltInOverride = (toolId: string): boolean =>
  Boolean(registryMap.get(toolId)?.copilot?.overridesBuiltInTool);

export const filterCopilotSupportedToolIds = (toolIds: string[]): string[] =>
  toolIds.filter(isMacroToolSupportedByCopilot);

export interface FunctionToolShape {
  type: "function";
  function: {
    name: string;
    description: string;
    parameters: JsonSchema;
  };
  overridesBuiltInTool?: true;
}

export const toFunctionToolShape = (
  entry: MacroToolRegistryEntry,
): FunctionToolShape => ({
  type: "function",
  function: {
    name: entry.id,
    description: entry.description,
    parameters: entry.parameters,
  },
});

export const toCopilotFunctionToolShape = (
  entry: MacroToolRegistryEntry,
): FunctionToolShape => {
  const shape = toFunctionToolShape(entry);
  return entry.copilot?.overridesBuiltInTool
    ? {
        ...shape,
        overridesBuiltInTool: true,
      }
    : shape;
};
