# Macro - The Organized Vibe-Coding Editor

## 1. Project Vision
Macro is a code editor designed specifically for "organized vibe-coding." Unlike tools that focus solely on AI generation, Macro emphasizes the **methodology** of coding with AI—ensuring that rapid generation doesn't lead to technical debt or unmaintainable code.

### Core Philosophy: "The Macro Method"
1.  **Intent-First**: Every change begins with an explicit declaration of intent.
2.  **Iterative Validation**: AI generations are broken down into small, verifiable steps.
3.  **Human Over-loop**: The human developer remains the "Architect," while AI serves as the "Builder."
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
*   **Intent Tracker**: A sidebar dedicated to the current "Mission."
*   **Review Mode**: A visual diffing system that forces human review before "Vibrations" are merged.
*   **Quality Gates**: Automated linting/testing that runs instantly after AI generation.

### Phase 3: Project Intelligence
*   **Codebase Indexing**: Using `tree-sitter` for semantic understanding.
*   **Semantic Search**: Local vector DB for context retrieval.
*   **Model Provider Abstraction**: Support for OpenAI, Anthropic, and local LLMs (Ollama/LocalAI).

---

## 4. Exhaustive Question List (The "Discovery" Phase)

### 4.1 UI/UX Design
1.  Should the layout be "Classic IDE" (File tree on left, editor center, chat on right) or something more innovative (especially for multi-project workspaces)?
2.  Do we want a "Zen Mode" where the code disappears and only the "Intent" is visible for high-level planning (with optional cross-project overview)?
3.  How should "Vibrations" (AI suggestions) be presented? Ghost text, inline widgets, separate panel, or distinct panels per project?
4.  Should multi-document editing be the default view (like Cursor's Composer), and how should this extend to multi-project scenarios?
5.  What transparency levels do we want for overlapping AI vs. Human changes, especially across project boundaries?
6.  Should we support "Canvas" style editing for visual project mapping, including cross-project dependency visualization?
7.  Do we need a visual representation of the "Intent Tree," including how intents span multiple projects?
8.  How should we handle mobile/tablet UI if we go cross-platform later, especially with multi-project complexity?
9.  Should there be a "Focus Mode" that hides the file tree and chat during active coding, with options to show only one project or all active projects?
10. Can we implement a "Time-Travel" UI to scroll through previous Vibe-coded versions, including cross-project intent history?

### 4.2 AI & Methodology
11. Which LLM provider should be default (Claude 3.5 Sonnet is current gold standard for code), especially for multi-project context understanding?
12. How strictly should we enforce "Macro Method"? Should it be impossible to write code without an Intent, even for single-file edits in multi-project workspaces?
13. Should the AI be allowed to run terminal commands autonomously (Agentic mode), and how does this apply across multiple projects with different runtimes/environments?
14. How do we handle "Context Poisoning" (AI getting confused by too many files), especially with multiple projects and their cross-references?
15. Should we store "Prompt Memories" to teach AI user's personal coding style, including cross-project coding patterns and preferences?
16. Can we implement "Prompt Templates" for common tasks (e.g., "Create React Component") and cross-project patterns (e.g., "Add endpoint + client")?
17. How should the AI handle existing code it didn't write, especially when that code spans multiple projects with different conventions?
18. Should we have a "Self-Correction" phase where a second, faster LLM reviews first LLM's output, particularly for cross-project consistency?
19. How do we manage the token usage vs. context depth trade-off in multi-project workspaces with potentially large shared context?
20. Should we support "Drafting" where AI proposes code in a temporary file first, and how does this work for cross-project changes?

### 4.3 Architecture & Performance
21. Should we use SQLite via Tauri for storing project state and history, including workspace-level cross-project relationships and metadata?
22. How do we handle large file systems and multiple projects without blocking the UI thread, especially during cross-project indexing?
23. Should editor be fully offline-capable by default, including cross-project features like shared type indexes and dependency graphs?
24. How do we build a plugin system that doesn't sacrifice performance (WASM-based), especially for plugins that might interact with multiple projects?
25. Should we use `libgit2` (Rust) for all git operations to ensure robustness, including multi-repo workspace operations?
26. How do we handle large files (10k+ lines) in CodeMirror 6 with AI decorations across multiple projects?
27. Should we use a Vector DB (like LanceDB) for local codebase indexing, and how should it handle cross-project semantic search?
28. How do we sync settings across different devices, including workspace configurations and project relationships?
29. Should we support remote development (SSH/Containers) in later versions, and how does this interact with multi-project workspaces?
30. What is our strategy for crash recovery (e.g., unsaved AI generations), especially for cross-project atomic operations?

### 4.4 Project Philosophy & Future
31. Is this a tool for professional developers, beginners, or both?
32. Should we prioritize "Speed of Vibe" or "Safety of Structure"?
33. Do we want to build a marketplace for "Vibe Workflows"?
34. How do we ensure Macro doesn't become "bloatware" over time?
35. Should there be a built-in "Learning Path" that explains code as it's generated?

### 4.5 Project Management (inspired by Speckle's Workspaces)
36. Should Macro support **multi-workspace** (like Speckle) for different teams/companies, and how does this interact with multi-project workspaces within each workspace?
37. How should **project organization** work — single-project-per-window, VS Code multi-root workspace style, or custom "collections" with enhanced multi-project features?
38. Should projects have **metadata** (tags, description, team members, creation date) for search/filtering, and should workspaces have their own metadata for project relationships?
39. Do we need **project templates** (React app, Tauri app, Rust library) and **multi-project templates** (mobile + backend, monorepo setups) with predefined structures and best practices?
40. Should projects be **local-only** by default with optional cloud sync, or cloud-first with local cache, and how does this apply to workspace configurations?
41. How to handle **project switching** — sidebar, command palette, or dedicated "Project Manager" window, especially when switching between projects within the same workspace?
42. Should we support **guest access** or sharing (read-only views, comment access) for code reviews, like Speckle, at the project or workspace level?
43. Do we need **role management** (Owner, Contributor, Viewer) for team collaboration features, with workspace-level vs. project-level permissions?
44. Should projects track **"AI sessions"** as entities at the workspace level — linking each AI generation to intent, files, commits, and affected projects?
45. How to handle **project import/export** — zip export, JSON manifest, or custom format for easy sharing, and should we support workspace-level import/export?

### 4.6 Git & Version Control Integration
46. Should Git be **deeply integrated** into Macro (like VS Code Git extension) or basic status only, especially for multi-repo workspaces?
47. How should AI-generated changes interact with Git — automatic commits per intent, manual review before commit, or staging area, and how does this apply to cross-project atomic operations?
48. Do we want **Git branch visualization** (graph, diff, branch management) integrated in the UI, including cross-project branch visualization?
49. Should Macro support **commit message templates** using AI (summarizing changes in structured format), especially for cross-project commits?
50. Should we implement **"Intent-based branching"** — each AI task creates a feature branch automatically, including cross-project branches?
51. How to handle **conflict resolution** — custom UI or delegate to standard Git tools, especially for cross-project merge conflicts?
52. Should we provide **"Time-Travel"** like Speckle — visual history of changes with ability to inspect older versions, including cross-project intent history?
53. Do we need **Git hooks integration** (pre-commit lint/tests, post-commit notifications) built into workflow gates, and how do hooks work across multiple repos?
54. Should we support **stashing / worktree management** for quick context switches during AI tasks, across multiple projects?
55. How to link **AI suggestions to Git commits** — store suggestion ID, commit hash, review status, and cross-project relationships for auditability?
56. Should we offer **"Undo Commit"** or revert options that integrate with Git history and AI review logs, including cross-project revert capabilities?
57. How to handle **large repositories** — shallow clone, sparse checkout, or full repo with smart caching, especially in multi-repo workspaces?
58. Do we need **remote Git integration** (GitHub/GitLab PRs, issues, CI status) visible in Macro, with cross-repo PR visualization?
59. Should we store **Git metadata** (branch, commit, status) in SQLite for fast UI rendering and search, including workspace-level git state?
60. How should **CodeMirror decorations** reflect Git status (added/modified lines, blame info) — inline or gutter, with project-specific indicators?

### 4.7 Collaboration & Team Features
61. Should we support **real-time collaboration** (multiple developers editing same file, cursor presence, cursors), and how does this work across multiple projects in a workspace?
62. Do we need **"Share Intent"** — ability to export AI intent/prompt + generated code as a reusable workflow, including cross-project workflows?
63. Should we implement **"Review Mode"** like Speckle — side-by-side diff with threaded comments per change, especially for cross-project changes?
64. How to handle **offline-first collaboration** — conflict resolution when rejoining after editing offline, in multi-project scenarios?
65. Should there be **"Team Templates"** — shared project structures and AI prompt templates across organizations, including multi-project workspace templates?
66. Do we want **"Project Dashboards"** showing metrics (commits, AI usage, quality gates, team activity), with workspace-level and project-level views?
67. How to manage **"Suggested Edits"** from team members — notification system, accept/reject workflow, tracking, across multiple projects?
68. Should we support **"Follow Mode"** for code reviews — follow a developer's cursor and changes in real-time, even across project boundaries?
69. How to handle **external collaborators** (guests, contractors) — permissions, expiration, audit trail, especially with multi-project access rights?
70. Do we need **"Team Onboarding"** flows — share project setups, AI preferences, and coding standards, including workspace-level onboarding for multi-project teams?

### 4.8 Multi-Project Management (Cross-Project Vibe-Coding)

#### 4.8.1 Workspace Model & Structure
**Q71**. How should we structure a "Macro workspace" for multiple projects?
   - a) `.macro-workspace` file referencing multiple folders (like VS Code multi-root)
   - b) Central file with metadata + shared vector index for all projects
   - c) Hybrid approach: workspace file + SQLite DB for relationships and cross-project indexing

**Q72**. How should the AI "see" and understand multiple projects?
   - a) As distinct entities with explicit bridges (e.g., "backend exposes API X → frontend consumes it")
   - b) As a semantic dependency graph with automatic relationship discovery
   - c) As a meta-project with clearly marked boundaries and explicit cross-project definitions

#### 4.8.2 AI Context Management
**Q73**. How should the AI select which files to include for a multi-project intent?
   - a) Automatic dependency analysis (imports, API calls, shared types, etc.)
   - b) Explicitly specified by the developer per intent
   - c) Hybrid: auto-inclusion with suggestions for additional relevant files

**Q74**. How to avoid "context pollution" when focusing on a specific project?
   - a) Automatic filtering based on the active intent's scope
   - b) Explicit "Focus Mode" vs. "Cross-Project Mode" toggle
   - c) Adaptive token limit with intelligent context pruning

**Q75**. How should we handle shared code/types between projects?
   - a) Monorepo-style with shared packages
   - b) Separate repos with automated sync/deduplication detection
   - c) Virtual shared modules that AI understands as "common code"

#### 4.8.3 Cross-Project Intents
**Q76**. How should we visually represent multi-project intentions?
   - a) Unified timeline with project tags/labels per change
   - b) Separate timelines per project + dedicated "Cross-Intent" view
   - c) Intent tree with branches spanning multiple projects

**Q77**. How should we handle simultaneous modifications across projects?
   - a) Diff view grouped by project in a single unified view
   - b) Composer-style (like Cursor) with multiple files from different projects side-by-side
   - c) "Intent Map" visual representation showing all affected projects and files

**Q78**. Should we support "atomic cross-project operations"?
   - a) Yes: all changes across projects must be accepted/rejected together
   - b) No: project-level granular acceptance is required
   - c) Hybrid: atomic by intent, but with project-level override options

#### 4.8.4 UX & Navigation
**Q79**. How should users navigate between projects in a multi-project workspace?
   - a) Sidebar with toggle buttons for "active projects"
   - b) Project tabs at the top of the editor (like browser tabs)
   - c) Visual canvas showing all projects and their interconnections

**Q80**. Should we provide a "Cross-Project Dependency Graph" view?
   - Yes: interactive graph showing API dependencies, shared types, and cross-project calls
   - No: keep it simple with traditional navigation
   - Optional: power-user feature for complex architectures

**Q81**. How should we handle file operations (move, rename, delete) across projects?
   - a) Explicit warnings when operations span projects
   - b) Allow freely but track as cross-project operations in intent history
   - c) Restrict to within-project only unless explicitly enabled

#### 4.8.5 Git & Version Control
**Q82**. How should we handle commits in a multi-project workspace?
   - a) Atomic cross-project commits (single commit touches multiple git repos)
   - b) Separate commits per project with relational tracking
   - c) User choice per intent: atomic or per-project

**Q83**. Should we support "cross-project branches"?
   - a) Yes: feature branches that exist across all affected projects
   - b) No: too complex, maintain independent branches
   - c) Optional: with guard rails and conflict resolution strategies

**Q84**. How should we display git status across multiple repositories?
   - a) Unified view showing all repos with aggregated status
   - b) Separate panels per repo with cross-project notification badges
   - c) Tabbed view with per-repo and "All Repos" summary

**Q85**. Should we implement "cross-project cherry-pick" and "cross-project revert"?
   - a) Yes: ability to revert a specific intent across all affected projects
   - b) No: handle per-project revert only
   - c: Conditional: only for intents marked as "atomic cross-project"

#### 4.8.6 AI Intelligence & Orchestration
**Q86**. Should the AI be "architecture-aware" of the multi-project setup?
   - a) Always: AI understands relationships and suggests cross-project changes
   - b) Explicit only: AI acts cross-project only when explicitly instructed
   - c) Hybrid: learns patterns over time but requires explicit confirmation for cross-project changes

**Q87**. How should we handle API contract changes between projects?
   - a) Automatic detection + suggestions for all affected code across projects
   - b) Explicit API contract files (OpenAPI, GraphQL schema, etc.) with AI validation
   - c) User-driven: developer specifies contract, AI suggests implementations

**Q88**. Should we implement "cross-project type synchronization"?
   - a) Yes: shared types automatically sync across projects (TypeScript, Rust structs, etc.)
   - b) Manual: developer triggers sync when needed
   - c) Suggestion-based: AI detects inconsistencies and proposes syncs

#### 4.8.7 Architecture & Technical Implementation
**Q89**. How should we store multi-project workspace state?
   - a) SQLite database in workspace root folder
   - b) JSON workspace file + separate vector database for indexing
   - c) Combined: workspace file for structure + SQLite for relationships + vector DB for search

**Q90**. How to handle large projects without saturating the cross-project index?
   - a) Incremental intelligent indexing (only index what changed)
   - b) On-demand indexing (index when user works on specific area)
   - c) Partial indexing by "intent zones" (index based on recent and active intents)

**Q91**. How should we manage project-specific settings in a multi-project workspace?
   - a) Inherit from workspace + per-project overrides
   - b) Independent per-project settings with workspace recommendations
   - c) Layered: workspace defaults → project defaults → folder overrides

#### 4.8.8 Specific Use Case: Mobile + Backend Web
**Q92**. For mobile + backend web scenarios, which cross-project features are critical?
   - a) API sync: generate mobile client code from backend API definitions
   - b) Shared types: TypeScript types/interfaces that work across both projects
   - c) Cross-project testing: E2E tests that span both mobile and backend
   - d) Live API documentation: auto-generated docs from backend, consumed by mobile team

**Q93**. How should the AI suggest modifications when working on mobile + backend?
   - a) "Change backend API" → automatically suggest "update mobile API client"
   - b) "Add endpoint" → generate "client wrapper + mobile UI screen for this endpoint"
   - c) All suggestions grouped by "Mission" with clear cross-project impact analysis

**Q94**. Should we support "preview mode" for cross-project changes?
   - a) Yes: simulate API changes and show mobile app with updated behavior
   - b) No: too complex, rely on testing
   - c: Optional: for API contract changes only

#### 4.8.9 Performance & Scalability
**Q95**. How many projects should a single workspace support?
   - a) Small (2-5): optimized for focused cross-project work
   - b) Medium (5-20): balanced approach
   - c) Large (20+): full monorepo support with scalability features

**Q96**. How should we handle file search across multiple projects?
   - a) Global search with project filters
   - b) Per-project search with "search all" option
   - c) Semantic search that understands project boundaries automatically

**Q97**. What is the strategy for workspace file watching across multiple git repos?
   - a) Single watcher process with per-repo git tracking
   - b) Separate watchers per project with aggregation
   - c: Git hook integration for efficient change detection

#### 4.8.10 Documentation & Knowledge Sharing
**Q98**. Should we support cross-project documentation?
   - a) Yes: unified docs that span multiple projects
   - b) No: per-project docs with cross-references
   - c: Hybrid: per-project docs with "workspace-level" overview

**Q99**. How should we handle API documentation in multi-project workspaces?
   - a) Auto-generate from backend, available to all projects
   - b) Manual documentation with AI assistance for keeping it updated
   - c: Contract-driven: API definition is source of truth, docs are auto-generated

**Q100**. Should we implement "workspace-level onboarding" for new team members?
   - a) Yes: explain architecture, project relationships, and development workflows
   - b) No: per-project onboarding only
   - c: Optional: team-configured onboarding flows

---

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
*   Inline "Vibration" UI (Ghost text).

### Step 4: The Organized Layer
*   "Intent" sidebar implementation.
*   Review diff view.
*   Automated shell command runner (for tests/lint).

---

## 6. Project Accountable Details
*   **Target Repo**: `Macro`
*   **Package Manager**: `pnpm`
*   **Frontend**: React (TSX)
*   **Backend**: Rust (Tauri)
*   **Editor Lib**: CodeMirror 6
