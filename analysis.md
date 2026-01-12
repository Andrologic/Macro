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
1.  Should the layout be "Classic IDE" (File tree on left, editor center, chat on right) or something more innovative?
2.  Do we want a "Zen Mode" where the code disappears and only the "Intent" is visible for high-level planning?
3.  How should "Vibrations" (AI suggestions) be presented? Ghost text, inline widgets, or a separate panel?
4.  Should multi-document editing be the default view (like Cursor's Composer)?
5.  What transparency levels do we want for overlapping AI vs. Human changes?
6.  Should we support "Canvas" style editing for visual project mapping?
7.  Do we need a visual representation of the "Intent Tree"?
8.  How should we handle mobile/tablet UI if we go cross-platform later?
9.  Should there be a "Focus Mode" that hides the file tree and chat during active coding?
10. Can we implement a "Time-Travel" UI to scroll through previous Vibe-coded versions?

### 4.2 AI & Methodology
11. Which LLM provider should be the default (Claude 3.5 Sonnet is current gold standard for code)?
12. How strictly should we enforce the "Macro Method"? Should it be impossible to write code without an Intent?
13. Should the AI be allowed to run terminal commands autonomously (Agentic mode)?
14. How do we handle "Context Poisoning" (AI getting confused by too many files)?
15. Should we store "Prompt Memories" to teach the AI the user's personal coding style?
16. Can we implement "Prompt Templates" for common tasks (e.g., "Create React Component")?
17. How should the AI handle existing code it didn't write?
18. Should we have a "Self-Correction" phase where a second, faster LLM reviews the first LLM's output?
19. How do we manage the token usage vs. context depth trade-off?
20. Should we support "Drafting" where AI proposes code in a temporary file first?

### 4.3 Architecture & Performance
21. Should we use SQLite via Tauri for storing project state and history?
22. How do we handle large file systems without blocking the UI thread?
23. Should the editor be fully offline-capable by default?
24. How do we build a plugin system that doesn't sacrifice performance (WASM-based)?
25. Should we use `libgit2` (Rust) for all git operations to ensure robustness?
26. How do we handle large files (10k+ lines) in CodeMirror 6 with AI decorations?
27. Should we use a Vector DB (like LanceDB) for local codebase indexing?
28. How do we sync settings across different devices?
29. Should we support remote development (SSH/Containers) in later versions?
30. What is our strategy for crash recovery (e.g., unsaved AI generations)?

### 4.4 Project Philosophy & Future
31. Is this a tool for professional developers, beginners, or both?
32. Should we prioritize "Speed of Vibe" or "Safety of Structure"?
33. Do we want to build a marketplace for "Vibe Workflows"?
34. How do we ensure Macro doesn't become "bloatware" over time?
35. Should there be a built-in "Learning Path" that explains code as it's generated?

### 4.5 Project Management (inspired by Speckle's Workspaces)
36. Should Macro support **multi-workspace** (like Speckle) for different teams/companies or single-project focus?
37. How should **project organization** work — single-project-per-window, VS Code workspace style, or custom "collections"?
38. Should projects have **metadata** (tags, description, team members, creation date) for search/filtering?
39. Do we need **project templates** (React app, Tauri app, Rust library) with predefined structures and best practices?
40. Should projects be **local-only** by default with optional cloud sync, or cloud-first with local cache?
41. How to handle **project switching** — sidebar, command palette, or dedicated "Project Manager" window?
42. Should we support **guest access** or sharing (read-only views, comment access) for code reviews, like Speckle?
43. Do we need **role management** (Owner, Contributor, Viewer) for team collaboration features?
44. Should projects track **"AI sessions"** as entities — linking each AI generation to intent, files, and commits?
45. How to handle **project import/export** — zip export, JSON manifest, or custom format for easy sharing?

### 4.6 Git & Version Control Integration
46. Should Git be **deeply integrated** into Macro (like VS Code Git extension) or basic status only?
47. How should AI-generated changes interact with Git — automatic commits per intent, manual review before commit, or staging area?
48. Do we want **Git branch visualization** (graph, diff, branch management) integrated in the UI?
49. Should Macro support **commit message templates** using AI (summarizing changes in structured format)?
50. Should we implement **"Intent-based branching"** — each AI task creates a feature branch automatically?
51. How to handle **conflict resolution** — custom UI or delegate to standard Git tools?
52. Should we provide **"Time-Travel"** like Speckle — visual history of changes with ability to inspect older versions?
53. Do we need **Git hooks integration** (pre-commit lint/tests, post-commit notifications) built into workflow gates?
54. Should we support **stashing / worktree management** for quick context switches during AI tasks?
55. How to link **AI suggestions to Git commits** — store suggestion ID, commit hash, and review status for auditability?
56. Should we offer **"Undo Commit"** or revert options that integrate with Git history and AI review logs?
57. How to handle **large repositories** — shallow clone, sparse checkout, or full repo with smart caching?
58. Do we need **remote Git integration** (GitHub/GitLab PRs, issues, CI status) visible in Macro?
59. Should we store **Git metadata** (branch, commit, status) in SQLite for fast UI rendering and search?
60. How should **CodeMirror decorations** reflect Git status (added/modified lines, blame info) — inline or gutter?

### 4.7 Collaboration & Team Features
61. Should we support **real-time collaboration** (multiple developers editing same file, cursor presence, cursors)?
62. Do we need **"Share Intent"** — ability to export AI intent/prompt + generated code as a reusable workflow?
63. Should we implement **"Review Mode"** like Speckle — side-by-side diff with threaded comments per change?
64. How to handle **offline-first collaboration** — conflict resolution when rejoining after editing offline?
65. Should there be **"Team Templates"** — shared project structures and AI prompt templates across organizations?
66. Do we want **"Project Dashboards"** showing metrics (commits, AI usage, quality gates, team activity)?
67. How to manage **"Suggested Edits"** from team members — notification system, accept/reject workflow, tracking?
68. Should we support **"Follow Mode"** for code reviews — follow a developer's cursor and changes in real-time?
69. How to handle **external collaborators** (guests, contractors) — permissions, expiration, audit trail?
70. Do we need **"Team Onboarding"** flows — share project setups, AI preferences, and coding standards?

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
