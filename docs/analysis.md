# Macro - The Organized Vibe-Coding Editor

## 1. Project Vision
Macro is a code editor designed specifically for "organized vibe-coding." Unlike tools that focus solely on AI generation, Macro emphasizes the **methodology** of coding with AI—ensuring that rapid generation doesn't lead to technical debt or unmaintainable code.

### Core Philosophy: "The Macro Method"
1.  **Architect-First**: Every change begins with structured planning in Architect mode.
2.  **Iterative Validation**: AI generations are broken down into small, verifiable tasks.
3.  **Human Over-loop**: The human developer is the "Architect" in Architect mode, AI executes as "Builder" in Implement mode.
4.  **Persistent Rationale**: The "why" behind every AI decision is tracked alongside the code.

---

## 2. Competitive Analysis: Learning from the Best

### Cursor AI (The Benchmark)
*   **Strengths**: "Composer" (multi-file editing), ultra-low latency Tab completion, deep codebase indexing.
*   **Weaknesses**: Closed source, proprietary models, can encourage "messy" generation without structure.
*   **Macro's Edge**: Open-source, local-first support, and built-in project organization tools that prevent the "Cursor Mess."

### OpenCode / VS Code
*   **Strengths**: Massive ecosystem, battle-tested Monaco editor.
*   **Weaknesses**: Heavy legacy architecture, AI is often an "extra" rather than the core.
*   **Macro's Edge**: A fresh, lean architecture built from the ground up for the AI-first era. No legacy "extension" bottlenecks.

---

## 3. Technical Implementation Plan

### Phase 1: Foundation (Current Focus)
*   **Editor**: CodeMirror 6 (Modular, performance-heavy, mobile-ready).
*   **UI Framework**: React + TailwindCSS + Shadcn/ui.
*   **State Management**: Zustand (Global) + Jotai (Component-level).
*   **Tauri Backend**: Rust for file system ops and local model orchestration.

### Phase 2: The Workflow (The "Organized" Part)
*   "Architect Mode": Global IDE mode for creating plans and high-level features.
*   "Implement Mode": Global IDE mode for executing tasks and making changes.
*   "Chat Interaction": Developer responds to AI questions through chat.
*   **Quality Gates**: Automated linting/testing that runs instantly after AI generation.

### Phase 3: Project Intelligence
*   **Codebase Indexing**: Using `tree-sitter` for semantic understanding.
*   **Semantic Search**: Local vector DB for context retrieval.
*   **Model Provider Abstraction**: Support for OpenAI, Anthropic, and local LLMs (Ollama/LocalAI).

---

## 4. Exhaustive Question List (The "Discovery" Phase)

### 4.1 UI/UX Design
1.  Should the layout be "Classic IDE" (File tree on left, editor center, chat on right) or something more innovative (especially for multi-project workspaces)?
Single central chat is always visible. Left panel has vertical tab groups for projects (like Chrome tab groups but vertical). Projects can be grouped: independent projects in separate groups for simultaneous work, or interdependent projects in same vertical tab group. Clicking on a multiprojet visually marks all its sub-projects as open. Right panel has git repository graph(s) - one per project being worked on. Commits are color-coded: green (completed), blue (planned), orange (in progress).
2.  Do we want a "Zen Mode" where the code disappears and only the "Intent" is visible for high-level planning (with optional cross-project overview)?
The code is always hidden unless the user wants to see it. The user should rarely do the work himself. But when he does, the code should be there and easy to access.
On the left side there is tabs with all the projects within the workspace. The user can switch between them to operate different task on it.
3.  How should the editor present code to the developer?
The editor should be mostly read-only. The user should only be able to make small adjustments if necessary. All major changes go through the task execution flow.
4.  How should the plan and task workflow work?
User enters "Architect mode" to create a high-level plan. AI generates a plan with all features and predicted git repository graph. Developer then goes into each task to provide more details before executing. In "Implement mode", AI executes tasks. AI may ask questions through chat that developer must answer. Code changes are shown for review before the AI applies them.
5.  What transparency levels do we want for overlapping AI vs. Human changes, especially across project boundaries?
We don't want the human to make changes directly. The human is only the architect, not the builder. The human should be able to suggest changes to the AI, but not make them directly.
6.  Should we support "Canvas" style editing for visual project mapping, including cross-project dependency visualization?
No. The user should not be making changes directly. The user is the architect, not the builder. The user should be able to see the project structure and dependencies, but not make changes directly.
7.  How should we visualize the plan structure?
The plan should show all tasks, their dependencies, and predicted git repository graph structure. The visual should be in the chat/plan area, not the code area.7.1. How should we organize and display tasks across multiple projects?
Single unified task list for all projects. Tasks are marked to show which sub-project they belong to. User can choose display order: priority order, creation order, last update date, etc. Tasks can be mixed between projects. A task that affects multiple projects appears once in the task list but is reflected in each project's predicted git repository graph.8.  How should we handle mobile/tablet UI if we go cross-platform later, especially with multi-project complexity?
The mobile/tablet UI should be a simplified version of the desktop UI. The user should be able to view plans and tasks, but not make major changes. The user can answer AI questions through chat, but the code area should be read-only.
9.  Should there be a "Focus Mode" that hides the file tree and chat during active coding, with options to show only one project or all active projects?
No. The user should not be making changes directly. The user is the architect, not the builder. The user should be able to see the project structure and dependencies, but not make changes directly.
10. Can we implement a "Time-Travel" UI to scroll through previous versions, including cross-project history?
Each task is supposed to be atomic and reversible. The user should be able to see the history of tasks and their changes, but not make changes directly. The user can revert tasks if necessary. It is deeply integrated with git.

### 4.2 AI & Methodology
11. Which LLM provider should be default, especially for multi-project context understanding?
OpenAI compatible API. We should also support local LLMs for privacy-conscious users. The AI should be able to understand the context of multiple projects within a workspace. Moreover, different models could be used for different tasks (e.g., code generation vs. planning).
12. How strictly should we enforce "Macro Method"? Should it be impossible to write code without an Intent, even for single-file edits in multi-project workspaces?
Yes it is possible to write code without an Intent, but it is discouraged. The user should always be in "Architect mode" when making major changes. The user can make small adjustments in "Implement mode", but major changes should go through the plan and task workflow.
13. Should the AI be allowed to run terminal commands autonomously (Agentic mode), and how does this apply across multiple projects with different runtimes/environments?
Yes, the user should be able to configure which commands the AI can run. The AI should be able to run commands in the context of each project, but the user should have control over which commands are allowed. Also include a Yolo mode. 
14. How do we handle "Context Poisoning" (AI getting confused by too many files), especially with multiple projects and their cross-references?
We should implement intelligent context selection. The AI should only see files that are relevant to the current task. The user can also specify which files to include or exclude from the context. The AI should be able to understand the relationships between projects and only include relevant files from other projects when necessary.
15. Should we store "Prompt Memories" to teach AI user's personal coding style, including cross-project coding patterns and preferences?
No
16. Can we implement "Prompt Templates" for common tasks (e.g., "Create React Component") and cross-project patterns (e.g., "Add endpoint + client")?
No
17. How should the AI handle existing code it didn't write, especially when that code spans multiple projects with different conventions?
The AI should be able to analyze existing code and understand its conventions. The AI should adapt its generation style to match the existing code, even across multiple projects. The user can also provide feedback to the AI to improve its understanding of the codebase.
18. Should we have a "Self-Correction" phase where a second, faster LLM reviews first LLM's output, particularly for cross-project consistency?
As an optional feature, yes. The user can enable a self-correction phase where a second LLM reviews the first LLM's output for consistency and quality. This is especially useful for cross-project changes where consistency is crucial.
19. How do we manage the token usage vs. context depth trade-off in multi-project workspaces with potentially large shared context?
We should implement intelligent context pruning. The AI should prioritize the most relevant files and code snippets for the current task. The user can also specify which files to include or exclude from the context. Additionally, we can use a vector database to store embeddings of the codebase for efficient retrieval of relevant context.
20. Should we support "Drafting" where AI proposes code in a temporary file first, and how does this work for cross-project changes?
Not necessary. The AI should generate code directly in the context of the current task. The user can review and approve the changes before they are applied. For cross-project changes, the AI should clearly indicate which projects and files are affected.

### 4.3 Architecture & Performance
21. Should we use SQLite via Tauri for storing project state and history, including workspace-level cross-project relationships and metadata?
SQLite stores only local data that should not be shared (e.g., chat history). Everything that must be shared for team work is stored in git: plans, tasks, predicted git repository graphs, project metadata, team templates. These are committed to dedicated branches (.macro-plans, .macro-templates) with versioning and auditability.
Yes. SQLite should store only informations that should stay local, like chat history. To improve collaboration, we should store plans, tasks, and project relationships in git via branching and a special folder structure.
22. How do we handle large file systems and multiple projects without blocking the UI thread, especially during cross-project indexing?
We should implement background indexing using Rust threads in the Tauri backend. The indexing process should be incremental and only index files that have changed. The AI should also be able to request specific files or directories to be indexed on-demand. Additionally, we can use a vector database for efficient semantic search across multiple projects.
23. Should editor be fully offline-capable by default, including cross-project features like shared type indexes and dependency graphs?
Yes. The editor should be fully offline-capable by default. All core features, including cross-project indexing and dependency graphs, should work without an internet connection. The user can choose to sync with git, but the core functionality should remain local. Same philosophy as git.
24. How do we build a plugin system that doesn't sacrifice performance (WASM-based), especially for plugins that might interact with multiple projects?
Plugin is out of scope for now.
25. Should we use `libgit2` (Rust) for all git operations to ensure robustness, including multi-repo workspace operations?
Yes. Using `libgit2` in Rust will provide a robust and efficient way to handle git operations. This is especially important for multi-repo workspaces where we need to manage multiple git repositories simultaneously. `libgit2` will allow us to perform complex operations like cross-project commits, branching, and merging with better performance and reliability.
26. How do we handle large files (10k+ lines) in CodeMirror 6 with AI decorations across multiple projects?
We should implement lazy loading and virtual scrolling for large files in CodeMirror 6. The AI decorations should be applied only to the visible portion of the file, and we can use a background process to pre-fetch and cache decorations for nearby lines. Additionally, we can implement a "Focus Mode" that allows the user to zoom in on specific sections of the file while hiding irrelevant code, especially when working across multiple projects.
27. Should we use a Vector DB (like LanceDB) for local codebase indexing, and how should it handle cross-project semantic search?
Yes. A Vector DB like LanceDB is ideal for local codebase indexing. It can efficiently store and retrieve embeddings of code snippets, allowing for fast semantic search across multiple projects. The Vector DB should be able to understand the relationships between projects and provide relevant context based on the current task. We can implement a unified index that spans all projects in the workspace, allowing the AI to retrieve relevant code snippets from any project when needed.
28. How do we sync settings across different devices, including workspace configurations and project relationships?
Using git.
29. Should we support remote development (SSH/Containers) in later versions, and how does this interact with multi-project workspaces?
Out of scope for now.
30. What is our strategy for crash recovery (e.g., unsaved AI generations), especially for cross-project atomic operations?
Out of scope for now.

### 4.4 Project Philosophy & Future
31. Is this a tool for professional developers, beginners, or both?
Both. Macro should cater to professional developers who want to streamline their workflow with AI assistance, as well as beginners who are learning to code and want structured guidance. The "Macro Method" provides a clear framework for both groups to follow, ensuring that code quality and maintainability are prioritized regardless of skill level.
32. Should we prioritize "Speed of Execution" or "Safety of Structure"?
Safety of Structure. The core philosophy of Macro is to promote organized vibe-coding, which emphasizes maintainability and code quality over rapid, unstructured generation. While speed is important, it should not come at the cost of creating technical debt or unmanageable codebases. The plan and task workflow ensures that every change is deliberate and well-structured.
33. Do we want to build a marketplace for reusable plans and templates?
No. The focus should be on providing a solid foundation for organized vibe-coding rather than creating a marketplace. However, we can consider allowing users to share their plans and templates within their teams or communities in the future.
34. How do we ensure Macro doesn't become "bloatware" over time?
We should maintain a lean core architecture and avoid adding unnecessary features that do not align with the core philosophy of organized vibe-coding. Regularly review and refactor the codebase to remove deprecated features and optimize performance. Additionally, we can implement a modular design that allows users to enable or disable features based on their needs, ensuring that the editor remains lightweight and efficient. Plugins will expand functionality without bloating the core.
35. Should there be a built-in "Learning Path" that explains code as it's generated?
The chat of the task will explain the code as it is generated. The user can ask questions about the code, and the AI will provide explanations and context. This is especially useful for beginners who are learning to code and want to understand the rationale behind the AI's decisions.

### 4.5 Project Management (inspired by Speckle's Workspaces)
36. Should Macro support **multi-workspace** (like Speckle) for different teams/companies, and how does this interact with multi-project workspaces within each workspace?
Out of scope for now.
37. How should **project organization** work — single-project-per-window, VS Code multi-root workspace style, or custom "collections" with enhanced multi-project features?
Vertical tab groups on left panel (like Chrome tab groups but vertical). Each group contains related projects. Can open multiprojets (groups of independent projects with no dependencies between them) that can advance simultaneously on different things while AI works. Interdependent projects are in same vertical tab group. Clicking on a multiprojet visually marks all its sub-projects as open.
38. Should projects have **metadata** (tags, description, team members, creation date) for search/filtering, and should workspaces have their own metadata for project relationships?
Yes. Project metadata stored in `.project-meta.yaml` file committed to git. This allows sharing across team and versioning of metadata. Tags, description, team member assignments, creation date, and project relationships are tracked in git history.
39. Do we need **project templates** (React app, Tauri app, Rust library) and **multi-project templates** (mobile + backend, monorepo setups) with predefined structures and best practices?
40. Should projects be **local-only** by default with optional cloud sync, or cloud-first with local cache, and how does this apply to workspace configurations?
41. How to handle **project switching** — sidebar, command palette, or dedicated "Project Manager" window, especially when switching between projects within the same workspace?
42. Should we support **guest access** or sharing (read-only views, comment access) for code reviews, like Speckle, at the project or workspace level?
43. Do we need **role management** (Owner, Contributor, Viewer) for team collaboration features, with workspace-level vs. project-level permissions?
44. Should projects track **"AI sessions"** as entities at the workspace level — linking each plan, task, files, commits, and affected projects?Yes. Plans, tasks, and predicted git repository graphs stored in dedicated branches (e.g., `.macro-plans/` branch). Each plan with its tasks and predictions is committed to this branch. Team members can clone and switch to `.macro-plans` branch to view all historical plans. Branches can be merged to main for permanent archiving.45. How to handle **project import/export** — zip export, JSON manifest, or custom format for easy sharing, and should we support workspace-level import/export?

### 4.6 Git & Version Control Integration
46. Should Git be **deeply integrated** into Macro (like VS Code Git extension) or basic status only, especially for multi-repo workspaces?
47. How should AI-generated changes interact with Git — automatic commits per intent, manual review before commit, or staging area, and how does this apply to cross-project atomic operations?
Automatic commits to dedicated branches. Each plan and its tasks are committed to a dedicated feature branch automatically. Predicted git repository graph is updated in `.macro-plans` branch. For cross-project operations, each project has its own branch but they are linked by plan ID.
48. Do we want **Git branch visualization** (graph, diff, branch management) integrated in the UI, including cross-project branch visualization?
49. Should Macro support **commit message templates** using AI (summarizing changes in structured format), especially for cross-project commits?
50. Should we implement **"Plan-based branching"** — each AI plan creates a feature branch automatically, including cross-project branches?
Yes. Each plan creates a dedicated feature branch automatically (e.g., `plan/user-profile-feature/`). For multi-project plans, each project has its own branch but they share same plan ID. The predicted git repository graph is committed to `.macro-plans` branch. When plan is completed, branches can be merged to main.
51. How to handle **conflict resolution** — custom UI or delegate to standard Git tools, especially for cross-project merge conflicts?
52. Should we provide **"Time-Travel"** like Speckle — visual history of changes with ability to inspect older versions, including cross-project intent history?
Yes. Use git history for Time-Travel. Navigate through `.macro-plans` branch to view historical plans, tasks, and their predicted git repository graphs. Each plan is committed as a separate commit in this branch. Can checkout specific plan commit to see exact state of plan and predictions.
53. Do we need **Git hooks integration** (pre-commit lint/tests, post-commit notifications) built into workflow gates, and how do hooks work across multiple repos?
54. Should we support **stashing / worktree management** for quick context switches during AI tasks, across multiple projects?
55. How to link **AI-generated changes to Git commits** — store plan ID, task ID, commit hash, review status, and cross-project relationships for auditability?
Plan ID and task ID are included in commit messages and commit metadata. Each commit is linked to its originating plan and task. Cross-project relationships are tracked via branch naming convention (e.g., `plan/ID/task/ID`). Git commit hash provides auditability.
56. Should we offer **"Undo Commit"** or revert options that integrate with Git history and AI review logs, including cross-project revert capabilities?
Use standard git revert/cherry-pick operations. Reverting a commit automatically identifies the associated plan and task. For cross-project operations, reverts are coordinated across all affected project branches. Git history provides full audit trail with plan and task linkage.
57. How to handle **large repositories** — shallow clone, sparse checkout, or full repo with smart caching, especially in multi-repo workspaces?
58. Do we need **remote Git integration** (GitHub/GitLab PRs, issues, CI status) visible in Macro, with cross-repo PR visualization?
59. Should we store **Git metadata** (branch, commit, status) in SQLite for fast UI rendering and search, including workspace-level git state?
No. Use git directly. Git stores all metadata needed. For fast UI rendering, cache active branch, commit, and status in memory. Git commands (e.g., `git status`, `git log`) provide workspace-level git state.
60. How should **CodeMirror decorations** reflect Git status (added/modified lines, blame info) — inline or gutter, with project-specific indicators?

### 4.7 Collaboration & Team Features
61. Should we support **real-time collaboration** (multiple developers editing same file, cursor presence, cursors), and how does this work across multiple projects in a workspace?
No. Focus on asynchronous collaboration via git. Team members work on their own copies of the codebase and share changes through git commits and pushes. Real-time collaboration adds complexity and is not aligned with the "Macro Method" of structured planning and task execution.
62. Do we need **"Share Plan"** — ability to share AI plan + tasks + predicted git repository graph as a reusable workflow, including cross-project workflows?
No. Plans, tasks, and predicted git repository graphs are stored in `.macro-plans` branch. Team members simply checkout this branch to view historical plans. To share a plan, commit it to `.macro-plans` and push to remote.
63. Should we implement **"Review Mode"** like Speckle — side-by-side diff with threaded comments per change, especially for cross-project changes?
Out of scope for now.
64. How to handle **offline-first collaboration** — conflict resolution when rejoining after editing offline, in multi-project scenarios?
No. Focus on git for collaboration. Git handles offline edits and conflict resolution when rejoining. Each team member works on their own local copy and pushes changes to remote when online. Git's built-in merge and conflict resolution tools manage any conflicts that arise.
65. Should there be **"Team Templates"** — shared project structures and AI prompt templates across organizations, including multi-project workspace templates?
No, there is no templates feature for now.
66. Do we want **"Project Dashboards"** showing metrics (commits, AI usage, quality gates, team activity), with workspace-level and project-level views?
Out of scope for now.
67. How to manage **"Suggested Edits"** from team members — notification system, accept/reject workflow, tracking, across multiple projects?
No. Focus on git for collaboration. Team members suggest edits by creating branches and submitting pull requests. The project maintainer reviews and merges changes through standard git workflows. This approach leverages existing tools and avoids adding complexity to Macro.
68. Should we support **"Follow Mode"** for code reviews — follow a developer's cursor and changes in real-time, even across project boundaries?
No. Focus on asynchronous collaboration via git. Real-time follow mode adds complexity and is not aligned with the "Macro Method" of structured planning and task execution.
69. How to handle **external collaborators** (guests, contractors) — permissions, expiration, audit trail, especially with multi-project access rights?
Out of scope for now.
70. Do we need **"Team Onboarding"** flows — share project setups, AI preferences, and coding standards, including workspace-level onboarding for multi-project teams?
Out of scope for now.

### 4.8 Multi-Project Management (Cross-Project Vibe-Coding)

#### 4.8.1 Workspace Model & Structure
**Q71**. How should we structure a "Macro workspace" for multiple projects?
   - a) `.macro-workspace` file referencing multiple folders (like VS Code multi-root)
   - b) Central file with metadata + shared vector index for all projects
   - c) Hybrid approach: workspace file + SQLite DB for relationships and cross-project indexing
   The user will choose where each project is located on disk when creating or opening a multi-project workspace. The workspace file will only store which projects are part of the workspace. The actual projects can be anywhere on disk.

**Q72**. How should the AI "see" and understand multiple projects?
   - a) As distinct entities with explicit bridges (e.g., "backend exposes API X → frontend consumes it")
   - b) As a semantic dependency graph with automatic relationship discovery
   - c) As a meta-project with clearly marked boundaries and explicit cross-project definitions
   There will be markdown files in each project that define its API contracts, shared types, and dependencies on other projects. The AI will use these files to understand the relationships between projects. This file will be committed to git so that it is versioned and shareable across the team. It is generated and updated by the AI as needed.

#### 4.8.2 AI Context Management
**Q73**. How should the AI select which files to include for a multi-project intent?
   - a) Automatic dependency analysis (imports, API calls, shared types, etc.)
   - b) Explicitly specified by the developer per intent
   - c) Hybrid: auto-inclusion with suggestions for additional relevant files
   The AI will automatically include files based on dependency analysis. The user can also specify additional files to include or exclude for each intent.

**Q74**. How to avoid "context pollution" when focusing on a specific project?
   - a) Automatic filtering based on the active intent's scope
   - b) Explicit "Focus Mode" vs. "Cross-Project Mode" toggle
   - c) Adaptive token limit with intelligent context pruning
   a and c

**Q75**. How should we handle shared code/types between projects?
   - a) Monorepo-style with shared packages
   - b) Separate repos with automated sync/deduplication detection
   - c) Virtual shared modules that AI understands as "common code"
   b

#### 4.8.3 Cross-Project Intents
**Q76**. How should we visually represent multi-project plans?
   - a) Unified timeline with project tags/labels per change
   - b) Separate timelines per project + dedicated "Cross-Plan" view
   - c) Plan tree with branches spanning multiple projects
   The predicted git repository graph will be shown on the right panel. There will be multiple git repository graphs - one per project being worked on. Each graph shows predicted git structure based on tasks in that project. Tasks affecting multiple projects are reflected in each graph. Commits are color-coded: green (completed), blue (planned), orange (in progress).
   However, the task list is unified for all projects. Tasks are marked to show which sub-project they belong to. User can choose display order: priority order, creation order, last update date, etc. Tasks can be mixed between projects. A task that affects multiple projects appears once in the task list but is reflected in each project's predicted git repository graph.

**Q77**. How should we handle simultaneous modifications across projects?
   - a) Diff view grouped by project in a single unified view
   - b) Composer-style (like Cursor) with multiple files from different projects side-by-side
   - c) "Plan Map" visual representation showing all affected projects and files. Tasks that affect multiple projects appear once in unified task list but are reflected in each project's predicted git repository graph
   The modifications will be shown in the chat. Important modifications will be selected by the AI and shown in the chat for review. The user can click on each modification to see the full diff in pop-up window. The user can approve or reject each modification before it is applied.

**Q78**. Should we support "atomic cross-project operations"?
   - a) Yes: all changes across projects must be accepted/rejected together
   - b) No: project-level granular acceptance is required
   - c) Hybrid: atomic by intent, but with project-level override options
   a) All changes across projects must be accepted/rejected together. The user can review all changes in the chat and approve or reject them as a whole. This ensures consistency across projects and prevents partial updates that could lead to broken functionality.

#### 4.8.4 UX & Navigation
**Q79**. How should users navigate between projects in a multi-project workspace?
   - a) Vertical tab groups on left panel: Independent multiprojets in separate groups can advance simultaneously on different things while AI works. Interdependent projects are grouped together in same vertical tab group (like Chrome tab groups but vertical). Clicking on a multiprojet visually marks all its sub-projects as open.
   - b) Project tabs at the top of the editor (like browser tabs)
   - c) Visual canvas showing all projects and their interconnections
   There is no navigation between projects. The user can see all projects in the left panel and switch between them by clicking on the project name. The user can also see the predicted git repository graph for each project on the right panel. The user can work on tasks from multiple projects simultaneously.

**Q80**. Should we provide a "Cross-Project Dependency Graph" view?
   - Yes: interactive graph showing API dependencies, shared types, and cross-project calls
   - No: keep it simple with traditional navigation
   - Optional: power-user feature for complex architectures
   No

**Q81**. How should we handle file operations (move, rename, delete) across projects?
   - a) Explicit warnings when operations span projects
   - b) Allow freely but track as cross-project operations in intent history
   - c) Restrict to within-project only unless explicitly enabled
   Tracking will be managed by git. Each project has its own git repository. File operations are tracked as part of the git history. If a file is moved or renamed across projects, the user must commit the changes in both projects' git repositories. The AI will assist in generating the necessary git commands to reflect these changes.

#### 4.8.5 Git & Version Control
**Q82**. How should we handle commits in a multi-project workspace?
   - a) Atomic cross-project commits (single commit touches multiple git repos)
   - b) Separate commits per project with relational tracking
   - c) User choice per intent: atomic or per-project
   b) Separate commits per project with relational tracking. Each project has its own git repository and commits are made separately. The AI tracks the relationship between commits across projects using plan and task IDs. This allows for clear auditability and versioning while maintaining project independence.

**Q83**. Should we support "cross-project branches"?
   - a) Yes: feature branches that exist across all affected projects
   - b) No: too complex, maintain independent branches
   - c) Optional: with guard rails and conflict resolution strategies
   a) Yes: feature branches that exist across all affected projects. Each project has its own branch, but they share the same branch name for cross-project features (e.g., `feature/user-authentication/`). This allows for coordinated development across projects while maintaining project independence.

**Q84**. How should we display git status across multiple repositories?
   - a) Multiple git repository graphs on right panel - one per project being worked on. Each graph shows predicted git structure based on tasks in that project. Tasks affecting multiple projects are reflected in each graph. Commits are color-coded: green (completed), blue (planned), orange (in progress).
   - b) Separate panels per repo with cross-project notification badges
   - c) Tabbed view with per-repo and "All Repos" summary
   a) Multiple git repository graphs on right panel - one per project being worked on. Each graph shows predicted git structure based on tasks in that project. Tasks affecting multiple projects are reflected in each graph. Each graph is in a different tab on the right panel. The user can switch between tabs to see the git status for each project.

**Q85**. Should we implement "cross-project cherry-pick" and "cross-project revert"?
   - a) Yes: ability to revert a specific intent across all affected projects
   - b) No: handle per-project revert only
   - c: Conditional: only for intents marked as "atomic cross-project"
   a) Yes: ability to revert a specific intent across all affected projects. The user can select an intent from the plan history and choose to revert it. The AI generates the necessary git commands to revert the changes in all affected projects' git repositories, ensuring consistency across the workspace.

#### 4.8.6 AI Intelligence & Orchestration
**Q86**. Should the AI be "architecture-aware" of the multi-project setup?
   - a) Always: AI understands relationships and suggests cross-project changes
   - b) Explicit only: AI acts cross-project only when explicitly instructed
   - c) Hybrid: learns patterns over time but requires explicit confirmation for cross-project changes
   a) Always: AI understands relationships and suggests cross-project changes. The AI uses the project metadata files to understand the relationships between projects. It automatically suggests cross-project changes when working on tasks that affect multiple projects. The user can review and approve these suggestions before they are applied.

**Q87**. How should we handle API contract changes between projects?
   - a) Automatic detection + suggestions for all affected code across projects
   - b) Explicit API contract files (OpenAPI, GraphQL schema, etc.) with AI validation
   - c) User-driven: developer specifies contract, AI suggests implementations
   b) Explicit API contract files (OpenAPI, GraphQL schema, etc.) with AI validation. Each project has a dedicated file that defines its API contracts. The AI uses these files to validate changes and suggest implementations in other projects that consume the API. This ensures consistency and reduces the risk of breaking changes.

**Q88**. Should we implement "cross-project type synchronization"?
   - a) Yes: shared types automatically sync across projects (TypeScript, Rust structs, etc.)
   - b) Manual: developer triggers sync when needed
   - c) Suggestion-based: AI detects inconsistencies and proposes syncs
   c) Suggestion-based: AI detects inconsistencies and proposes syncs. The AI analyzes the codebases of all projects in the workspace and detects inconsistencies in shared types. When it finds discrepancies, it suggests updates to synchronize the types across projects. The user can review and approve these suggestions before they are applied.

#### 4.8.7 Architecture & Technical Implementation
**Q89**. How should we store multi-project workspace state?
   - a) SQLite database in workspace root folder
   - b) JSON workspace file + separate vector database for indexing
   - c) Combined: workspace file for structure + SQLite for relationships + vector DB for search
   c) Combined: workspace file for structure + SQLite for relationships + vector DB for search. The workspace file stores the list of projects and their metadata. SQLite database tracks relationships between projects, intents, tasks, and git commits. The vector database indexes code snippets from all projects for efficient semantic search.

**Q90**. How to handle large projects without saturating the cross-project index?
   - a) Incremental intelligent indexing (only index what changed)
   - b) On-demand indexing (index when user works on specific area)
   - c) Partial indexing by "intent zones" (index based on recent and active intents)
   a) Incremental intelligent indexing (only index what changed). The vector database only indexes files that have changed since the last indexing operation. The AI can also request specific files or directories to be indexed on-demand when working on tasks that require them. This approach minimizes resource usage while ensuring relevant context is available.

**Q91**. How should we manage project-specific settings in a multi-project workspace?
   - a) Inherit from workspace + per-project overrides
   - b) Independent per-project settings with workspace recommendations
   - c) Layered: workspace defaults → project defaults → folder overrides
   a) Inherit from workspace + per-project overrides. The workspace has default settings that apply to all projects. Each project can override these settings as needed. This allows for consistency across the workspace while still providing flexibility for individual projects.

#### 4.8.9 Performance & Scalability
**Q95**. How many projects should a single workspace support?
   - a) Small (2-5): optimized for focused cross-project work
   - b) Medium (5-20): balanced approach
   - c) Large (20+): full monorepo support with scalability features
   a) Small (2-5): optimized for focused cross-project work. The initial implementation will focus on supporting a small number of projects per workspace to ensure optimal performance and usability. As the product matures, we can explore scaling to support more projects if there is demand.

**Q96**. How should we handle file search across multiple projects?
   - a) Global search with project filters
   - b) Per-project search with "search all" option
   - c) Semantic search that understands project boundaries automatically
   c) Semantic search that understands project boundaries automatically. The vector database enables semantic search across all projects in the workspace. The AI understands the relationships between projects and can provide relevant results based on the current task. The user can also filter results by project if needed.

## 5. Implementation Roadmap (Detailed)

### Step 1: Bootstrap
*   Setup Tauri v2 structure.
*   Configure Vite + React component aliases.
*   Initialize Tailwind + Shadcn.

### Step 2: Core Editor
*   Integrate CodeMirror 6 with basic TS/Rust highlighting.
*   Implement Tab system (Zustand).
*   File system bridge (Tauri `fs` + `path`).

### Step 3: AI Bridge
*   Secure API key storage (Tauri `store` or OS Keyring).
*   Streaming response integration.
*   Plan generation with git repository graph prediction.
*   Task execution with chat-based questions.

### Step 4: The Organized Layer
*   "Plan" sidebar implementation.
*   Task detail view.
*   Automated shell command runner (for tests/lint).

---

## 6. Project Accountable Details
*   **Target Repo**: `Macro`
*   **Package Manager**: `pnpm`
*   **Frontend**: React (TSX)
*   **Backend**: Rust (Tauri)
*   **Editor Lib**: CodeMirror 6
