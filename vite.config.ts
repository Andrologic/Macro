import { existsSync, readFileSync, readdirSync } from "node:fs";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig, transformWithEsbuild } from "vite";
import react from "@vitejs/plugin-react";

// @ts-expect-error process is a nodejs global
const host = process.env.TAURI_DEV_HOST;
const projectRoot = dirname(fileURLToPath(import.meta.url));
const ALLOWED_PUBLIC_SECRET_FILES = new Set(["ai-keys.local.example.json"]);
const MERMAID_PARSER_VIRTUAL_PREFIX = "\0macro-mermaid-parser-source:";

export const isPathInside = (parentPath: string, candidatePath: string): boolean => {
  const relativePath = relative(parentPath, candidatePath);
  return (
    relativePath !== "" &&
    relativePath !== ".." &&
    !relativePath.startsWith(`..${sep}`) &&
    !isAbsolute(relativePath)
  );
};

const createMermaidParserSourcePlugin = () => {
  const parserPackageRoot = resolve(projectRoot, "node_modules/@mermaid-js/parser");
  const parserDistRoot = resolve(parserPackageRoot, "dist");
  const parserSourceRoot = resolve(parserPackageRoot, "src");
  const sourceByAbsolutePath = new Map<string, string>();

  const visitSourceMaps = (directory: string): void => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const entryPath = resolve(directory, entry.name);
      if (entry.isDirectory()) {
        visitSourceMaps(entryPath);
        continue;
      }
      if (!entry.name.endsWith(".mjs.map")) continue;

      const sourceMap = JSON.parse(readFileSync(entryPath, "utf8")) as {
        sources?: string[];
        sourcesContent?: Array<string | null>;
      };
      sourceMap.sources?.forEach((sourcePath, index) => {
        const absoluteSourcePath = resolve(dirname(entryPath), sourcePath);
        const source = sourceMap.sourcesContent?.[index];
        if (
          isPathInside(parserSourceRoot, absoluteSourcePath) &&
          typeof source === "string"
        ) {
          sourceByAbsolutePath.set(absoluteSourcePath, source);
        }
      });
    }
  };

  visitSourceMaps(parserDistRoot);

  const parserLanguageEntrypoints: Record<string, string[]> = {
    info: ["InfoModule", "createInfoServices"],
    packet: ["PacketModule", "createPacketServices"],
    pie: ["PieModule", "createPieServices"],
    architecture: ["ArchitectureModule", "createArchitectureServices"],
    gitGraph: ["GitGraphModule", "createGitGraphServices"],
    eventmodeling: ["EventModelingModule", "createEventModelingServices"],
    radar: ["RadarModule", "createRadarServices"],
    railroad: ["RailroadModule", "createRailroadServices"],
    "railroad-abnf": ["RailroadAbnfModule", "createRailroadAbnfServices"],
    "railroad-ebnf": ["RailroadEbnfModule", "createRailroadEbnfServices"],
    "railroad-peg": ["RailroadPegModule", "createRailroadPegServices"],
    treemap: ["TreemapModule", "createTreemapServices"],
    treeView: ["TreeViewModule", "createTreeViewServices"],
    wardley: ["WardleyModule", "createWardleyServices"],
    cynefin: ["CynefinModule", "createCynefinServices"],
  };
  Object.entries(parserLanguageEntrypoints).forEach(([directory, exports]) => {
    sourceByAbsolutePath.set(
      resolve(parserSourceRoot, "language", directory, "index.ts"),
      `export { ${exports.join(", ")} } from "./module.js";`
    );
  });
  sourceByAbsolutePath.set(
    resolve(parserSourceRoot, "language/common/index.ts"),
    [
      'export * from "./matcher.js";',
      'export * from "./tokenBuilder.js";',
      'export * from "./valueConverter.js";',
    ].join("\n")
  );
  sourceByAbsolutePath.set(
    resolve(parserSourceRoot, "index.ts"),
    [
      'export { MermaidParseError, parse } from "./parse.js";',
      'export { isEmResetFrame } from "./language/generated/ast.js";',
      'export { createRailroadServices } from "./language/railroad/index.js";',
      'export { createRailroadAbnfServices } from "./language/railroad-abnf/index.js";',
      'export { createRailroadEbnfServices } from "./language/railroad-ebnf/index.js";',
      'export { createRailroadPegServices } from "./language/railroad-peg/index.js";',
    ].join("\n")
  );

  const resolveVirtualSource = (absolutePath: string): string | null => {
    const candidates = [
      absolutePath,
      absolutePath.replace(/\.js$/, ".ts"),
      resolve(absolutePath, "index.ts"),
    ];
    const match = candidates.find((candidate) => sourceByAbsolutePath.has(candidate));
    return match ? `${MERMAID_PARSER_VIRTUAL_PREFIX}${match}` : null;
  };

  const parserEntry = resolveVirtualSource(resolve(parserSourceRoot, "index.ts"));
  if (!parserEntry) {
    throw new Error(
      "Unable to recover @mermaid-js/parser sources for bundle-safe code splitting."
    );
  }

  return {
    name: "macro-mermaid-parser-source-split",
    enforce: "pre" as const,
    resolveId(source: string, importer?: string) {
      if (source === "@mermaid-js/parser") return parserEntry;
      if (!importer?.startsWith(MERMAID_PARSER_VIRTUAL_PREFIX) || !source.startsWith(".")) {
        return null;
      }
      const importerPath = importer.slice(MERMAID_PARSER_VIRTUAL_PREFIX.length);
      return resolveVirtualSource(resolve(dirname(importerPath), source));
    },
    load(id: string) {
      if (!id.startsWith(MERMAID_PARSER_VIRTUAL_PREFIX)) return null;
      return sourceByAbsolutePath.get(id.slice(MERMAID_PARSER_VIRTUAL_PREFIX.length)) ?? null;
    },
    async transform(code: string, id: string) {
      if (!id.startsWith(MERMAID_PARSER_VIRTUAL_PREFIX)) return null;
      return transformWithEsbuild(
        code,
        id.slice(MERMAID_PARSER_VIRTUAL_PREFIX.length),
        { loader: "ts", target: "esnext", sourcemap: false }
      );
    },
  };
};

const readPackageVersion = (rootDir: string = projectRoot): string => {
  const packageJsonPath = resolve(rootDir, "package.json");
  const packageJson = JSON.parse(readFileSync(packageJsonPath, "utf8")) as {
    version?: unknown;
  };

  if (typeof packageJson.version !== "string" || packageJson.version.trim().length === 0) {
    throw new Error(`Missing package.json version in ${packageJsonPath}`);
  }

  return packageJson.version.trim();
};

const hasNodePackage = (moduleId: string, packageName: string): boolean =>
  moduleId.includes(`/node_modules/${packageName}/`);

const sanitizeChunkName = (name: string): string =>
  name.replace(/[^a-zA-Z0-9_-]/g, '_');

const manualVendorChunk = (id: string): string | undefined => {
  const moduleId = id.replace(/\\/g, "/");

  if (!moduleId.includes("/node_modules/")) {
    return undefined;
  }

  if (
    hasNodePackage(moduleId, "react") ||
    hasNodePackage(moduleId, "react-dom")
  ) {
    return "react-vendor";
  }

  if (hasNodePackage(moduleId, "zustand") || hasNodePackage(moduleId, "jotai")) {
    return "state-vendor";
  }

  if (hasNodePackage(moduleId, "@xyflow/react")) {
    return "graph-vendor";
  }

  if (
    hasNodePackage(moduleId, "@dnd-kit/core") ||
    hasNodePackage(moduleId, "@dnd-kit/sortable") ||
    hasNodePackage(moduleId, "@dnd-kit/utilities")
  ) {
    return "dnd-vendor";
  }

  if (hasNodePackage(moduleId, "@codemirror/merge")) {
    return "editor-merge";
  }

  if (
    hasNodePackage(moduleId, "codemirror") ||
    hasNodePackage(moduleId, "@codemirror/autocomplete") ||
    hasNodePackage(moduleId, "@codemirror/commands") ||
    hasNodePackage(moduleId, "@codemirror/lang-javascript") ||
    hasNodePackage(moduleId, "@codemirror/lang-rust") ||
    hasNodePackage(moduleId, "@codemirror/language") ||
    hasNodePackage(moduleId, "@codemirror/lint") ||
    hasNodePackage(moduleId, "@codemirror/search") ||
    hasNodePackage(moduleId, "@codemirror/theme-one-dark") ||
    hasNodePackage(moduleId, "@lezer/common") ||
    hasNodePackage(moduleId, "@lezer/highlight") ||
    hasNodePackage(moduleId, "@lezer/javascript") ||
    hasNodePackage(moduleId, "@lezer/lr")
  ) {
    return "editor-extensions";
  }

  if (
    hasNodePackage(moduleId, "@codemirror/state") ||
    hasNodePackage(moduleId, "@codemirror/view")
  ) {
    return "editor-core";
  }

  if (
    hasNodePackage(moduleId, "lexical") ||
    hasNodePackage(moduleId, "@lexical/clipboard") ||
    hasNodePackage(moduleId, "@lexical/react") ||
    hasNodePackage(moduleId, "@lexical/selection") ||
    hasNodePackage(moduleId, "@lexical/utils")
  ) {
    return "composer-lexical";
  }

  if (hasNodePackage(moduleId, "katex")) {
    return "markdown-math-vendor";
  }

  if (hasNodePackage(moduleId, "highlight.js")) {
    return "markdown-highlight-vendor";
  }

  if (
    hasNodePackage(moduleId, "react-markdown") ||
    hasNodePackage(moduleId, "rehype-katex") ||
    hasNodePackage(moduleId, "remark-gfm") ||
    hasNodePackage(moduleId, "remark-math") ||
    hasNodePackage(moduleId, "remark-parse") ||
    hasNodePackage(moduleId, "remark-rehype") ||
    hasNodePackage(moduleId, "rehype-react") ||
    hasNodePackage(moduleId, "unified") ||
    hasNodePackage(moduleId, "micromark") ||
    hasNodePackage(moduleId, "mdast-util-from-markdown") ||
    hasNodePackage(moduleId, "mdast-util-gfm") ||
    hasNodePackage(moduleId, "mdast-util-math") ||
    hasNodePackage(moduleId, "mdast-util-to-hast") ||
    hasNodePackage(moduleId, "hast-util-to-jsx-runtime") ||
    hasNodePackage(moduleId, "hast-util-whitespace") ||
    hasNodePackage(moduleId, "hast-util-to-text") ||
    hasNodePackage(moduleId, "unist-util-is") ||
    hasNodePackage(moduleId, "unist-util-position") ||
    hasNodePackage(moduleId, "unist-util-stringify-position") ||
    hasNodePackage(moduleId, "unist-util-visit") ||
    hasNodePackage(moduleId, "unist-util-visit-parents") ||
    hasNodePackage(moduleId, "vfile") ||
    hasNodePackage(moduleId, "vfile-message")
  ) {
    return "markdown-parser-vendor";
  }

  if (
    hasNodePackage(moduleId, "cose-base") ||
    hasNodePackage(moduleId, "layout-base")
  ) {
    return "diagram-cytoscape-layout-vendor";
  }

  if (hasNodePackage(moduleId, "cytoscape")) {
    return "diagram-cytoscape-core-vendor";
  }

  if (
    hasNodePackage(moduleId, "cytoscape-cose-bilkent") ||
    hasNodePackage(moduleId, "cytoscape-fcose")
  ) {
    return "diagram-cytoscape-extensions-vendor";
  }

  if (
    hasNodePackage(moduleId, "d3") ||
    moduleId.includes("/node_modules/d3-")
  ) {
    return "diagram-d3-vendor";
  }

  if (
    hasNodePackage(moduleId, "dagre-d3-es") ||
    hasNodePackage(moduleId, "dagre") ||
    hasNodePackage(moduleId, "graphlib")
  ) {
    return "diagram-layout-vendor";
  }

  if (hasNodePackage(moduleId, "roughjs")) {
    return "diagram-render-vendor";
  }

  if (hasNodePackage(moduleId, "lodash-es")) {
    return "diagram-utility-vendor";
  }

  if (
    hasNodePackage(moduleId, "@braintree/sanitize-url") ||
    hasNodePackage(moduleId, "@iconify/utils") ||
    hasNodePackage(moduleId, "dayjs") ||
    hasNodePackage(moduleId, "dompurify") ||
    hasNodePackage(moduleId, "khroma") ||
    hasNodePackage(moduleId, "marked") ||
    hasNodePackage(moduleId, "stylis") ||
    hasNodePackage(moduleId, "ts-dedent") ||
    hasNodePackage(moduleId, "uuid")
  ) {
    return "diagram-support-vendor";
  }

  if (
    moduleId.includes("/node_modules/mermaid/dist/diagram-api/") ||
    moduleId.includes("/node_modules/mermaid/dist/rendering-util/") ||
    moduleId.includes("/node_modules/mermaid/dist/themes/") ||
    moduleId.includes("/node_modules/mermaid/dist/utils/")
  ) {
    return "diagram-mermaid-runtime";
  }

  if (
    moduleId.includes("/node_modules/mermaid/dist/mermaid") ||
    moduleId.includes("/node_modules/mermaid/dist/defaultConfig") ||
    moduleId.includes("/node_modules/mermaid/dist/config") ||
    moduleId.includes("/node_modules/mermaid/dist/Diagram")
  ) {
    return "diagram-vendor";
  }

  if (hasNodePackage(moduleId, "xterm") || hasNodePackage(moduleId, "xterm-addon-fit")) {
    return "terminal-vendor";
  }

  if (
    hasNodePackage(moduleId, "@tauri-apps/api") ||
    hasNodePackage(moduleId, "@tauri-apps/plugin-dialog") ||
    hasNodePackage(moduleId, "@tauri-apps/plugin-http") ||
    hasNodePackage(moduleId, "@tauri-apps/plugin-notification") ||
    hasNodePackage(moduleId, "@tauri-apps/plugin-opener") ||
    hasNodePackage(moduleId, "@tauri-apps/plugin-store")
  ) {
    return "desktop-vendor";
  }

  if (hasNodePackage(moduleId, "sonner")) {
    return "notifications-vendor";
  }

  if (
    hasNodePackage(moduleId, "i18next") ||
    hasNodePackage(moduleId, "react-i18next") ||
    hasNodePackage(moduleId, "i18next-browser-languagedetector") ||
    hasNodePackage(moduleId, "lucide-react") ||
    hasNodePackage(moduleId, "class-variance-authority") ||
    hasNodePackage(moduleId, "clsx") ||
    hasNodePackage(moduleId, "tailwind-merge")
  ) {
    return "utils-vendor";
  }

  return undefined;
};

const manualAppChunk = (id: string): string | undefined => {
  const moduleId = id.replace(/\\/g, "/");
  if (moduleId.includes("/node_modules/") || !moduleId.includes("/src/")) return undefined;
  if (moduleId.includes("/src/i18n/locales/")) return undefined;
  if (moduleId.includes("/src/components/chat/ContextWindowIndicator.")) return "chat-context-window";
  if (
    moduleId.includes("/src/components/chat/CompactionTranscriptUi.") ||
    moduleId.includes("/src/components/chat/transcriptItems.") ||
    moduleId.includes("/src/components/chat/useAgentCodeReplayConfirmation.") ||
    moduleId.includes("/src/components/chat/AgentCodeReplayConfirmModal.")
  ) return "chat-transcript-support";
  if (
    moduleId.includes("/src/components/chat/QuestionnaireFooter.") ||
    moduleId.includes("/src/components/chat/QuestionnaireResponseSummary.") ||
    moduleId.includes("/src/components/chat/ToolApprovalFooter.") ||
    moduleId.includes("/src/components/chat/ImplementTaskTodoDropdown.")
  ) return "chat-footer-support";
  if (moduleId.includes("/src/stores/")) return "app-stores";
  if (
    moduleId.includes("/src/services/architectPlan") ||
    moduleId.includes("/src/services/architectGit") ||
    moduleId.includes("/src/services/architectBranch") ||
    moduleId.includes("/src/services/architectScope") ||
    moduleId.includes("/src/services/architectStrategy") ||
    moduleId.includes("/src/services/architectAuto") ||
    moduleId.includes("/src/services/plan")
  ) return "architect-services";
  if (
    moduleId.includes("/src/services/architectTool") ||
    moduleId.includes("/src/services/workspaceTool") ||
    moduleId.includes("/src/shared/macroToolRegistry")
  ) return "tool-services";
  if (
    moduleId.includes("/src/services/chat") ||
    moduleId.includes("/src/services/context") ||
    moduleId.includes("/src/services/conversation") ||
    moduleId.includes("/src/services/streamingChat")
  ) return "chat-services";
  if (
    moduleId.includes("/src/services/provider") ||
    moduleId.includes("/src/services/reasoning") ||
    moduleId.includes("/src/services/aiConfig") ||
    moduleId.includes("/src/services/metadataModel")
  ) return "provider-services";
  if (
    moduleId.includes("/src/services/macro") ||
    moduleId.includes("/src/services/merge") ||
    moduleId.includes("/src/services/git") ||
    moduleId.includes("/src/services/task")
  ) return "workflow-services";
  if (moduleId.includes("/src/services/mcp/")) return "mcp-services";
  if (moduleId.includes("/src/services/")) return "app-services";
  if (moduleId.includes("/src/hooks/")) return "app-hooks";
  if (moduleId.includes("/src/i18n/")) return "app-i18n";
  if (moduleId.includes("/src/components/ui/") || moduleId.includes("/src/components/theme/")) {
    return "app-ui";
  }
  return undefined;
};

const manualChunk = (id: string): string | undefined =>
  manualVendorChunk(id) ?? manualAppChunk(id);

const collectProhibitedPublicSecretFiles = (dir: string, root: string): string[] => {
  if (!existsSync(dir)) {
    return [];
  }

  const prohibited: string[] = [];

  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const entryPath = resolve(dir, entry.name);
    if (entry.isDirectory()) {
      prohibited.push(...collectProhibitedPublicSecretFiles(entryPath, root));
      continue;
    }

    const isSecretJson = /^ai-keys.*\.json$/i.test(entry.name);
    if (isSecretJson && !ALLOWED_PUBLIC_SECRET_FILES.has(entry.name)) {
      prohibited.push(entryPath.slice(root.length + 1).replace(/\\/g, "/"));
    }
  }

  return prohibited;
};

export const validatePublicSecretFiles = (rootDir: string = projectRoot): void => {
  const publicDir = resolve(rootDir, "public");
  const prohibitedFiles = collectProhibitedPublicSecretFiles(publicDir, rootDir);

  if (prohibitedFiles.length === 0) {
    return;
  }

  throw new Error(
    [
      "Secret provider files are forbidden in public/ because Vite copies them into dist/.",
      `Move them to dev/${prohibitedFiles[0].split("/").pop() ?? "ai-keys.local.json"} and load them via Tauri dev overrides instead.`,
      `Blocked file${prohibitedFiles.length > 1 ? "s" : ""}: ${prohibitedFiles.join(", ")}`,
    ].join(" ")
  );
};

// https://vitejs.dev/config/
// Optimized for Bun runtime - Maximum Performance Configuration
export default defineConfig(({ command }) => {
  const appVersion = readPackageVersion(projectRoot);

  if (command === "build") {
    validatePublicSecretFiles(projectRoot);
  }

  return {
    base: command === "build" ? "./" : "/",
    define: {
      'import.meta.env.VITE_APP_VERSION': JSON.stringify(appVersion),
    },
    plugins: [
      createMermaidParserSourcePlugin(),
      react({
        // Use automatic JSX runtime for smaller bundle
        jsxRuntime: 'automatic',
      }),
    ],

    // =============================================================================
    // BUILD OPTIMIZATIONS - Code Splitting & Chunking
    // =============================================================================
    build: {
      // Target modern browsers for smaller bundles (Tauri uses WebView2/WebKit)
      target: "esnext",

      // Terser keeps the generated Mermaid parser below the existing release budget.
      minify: "terser",

      terserOptions: {
        compress: {
          passes: 2,
        },
        format: {
          comments: false,
        },
      },

      // Aggressive esbuild options
      esbuildOptions: {
        // Remove console.log in production
        drop: process.env.NODE_ENV === 'production' ? ['console', 'debugger'] : [],
        // Legal comments handling
        legalComments: 'none',
        // Target modern engines
        target: 'esnext',
      },

      // Code splitting configuration
      rollupOptions: {
        output: {
          // Manual chunks for optimal code splitting
          manualChunks: manualChunk,

          // Chunk naming strategy
          chunkFileNames: (chunkInfo) => {
            const chunkName = chunkInfo.name || (
              chunkInfo.facadeModuleId
                ? chunkInfo.facadeModuleId.split('/').pop()?.replace(/\.[^/.]+$/, '')
                : undefined
            );
            return `assets/${sanitizeChunkName(chunkName || 'chunk')}-[hash].js`;
          },

          // Entry file naming
          entryFileNames: "assets/[name]-[hash].js",

          // Asset file naming
          assetFileNames: (assetInfo) => {
            const info = assetInfo.name ? assetInfo.name.split('.') : [];
            const ext = info[info.length - 1];
            if (/\.(png|jpe?g|gif|svg|webp|ico)$/.test(assetInfo.name || '')) {
              return `assets/images/[name]-[hash][extname]`;
            }
            if (/\.(woff2?|ttf|otf|eot)$/.test(assetInfo.name || '')) {
              return `assets/fonts/[name]-[hash][extname]`;
            }
            return `assets/[name]-[hash][extname]`;
          },
        },
      },

      // Split CSS into separate files
      cssCodeSplit: true,

      // Modern CSS minification
      cssMinify: 'esbuild',

      // Macro's desktop shell intentionally keeps the primary app surface bundled.
      chunkSizeWarningLimit: 1200,

      // Disable source maps in production for smaller builds
      sourcemap: false,

      // Report compressed size for better analysis
      reportCompressedSize: true,

      // Inline assets under 4kb as base64
      assetsInlineLimit: 4096,
    },

    // =============================================================================
    // DEPENDENCY OPTIMIZATION - Pre-bundling
    // =============================================================================
    optimizeDeps: {
      // Dependencies to pre-bundle
      include: [
        "react",
        "react-dom",
        "react-dom/client",
        "react/jsx-runtime",
        "react/jsx-dev-runtime",
        "sonner",
        "zustand",
        "i18next",
        "react-i18next",
        "lucide-react",
        "class-variance-authority",
        "clsx",
        "tailwind-merge",
      ],

      // Exclude heavy dependencies that should be lazy loaded
      exclude: [
        "@codemirror/view",
        "@codemirror/state",
        "codemirror",
        "@xyflow/react",
      ],

      // Force re-optimization when these change
      force: false,
    },

    // =============================================================================
    // SERVER CONFIGURATION - Tauri Development
    // =============================================================================
    server: {
      port: 1422,
      strictPort: true,
      host: host || false,
      hmr: host
        ? {
          protocol: "ws",
          host,
          port: 1423,
        }
        : undefined,
      watch: {
        // Ignore src-tauri to prevent rebuild loops
        ignored: ["**/src-tauri/**"],
      },
    },

    // =============================================================================
    // PERFORMANCE OPTIMIZATIONS
    // =============================================================================

    // Prevent Vite from clearing screen (keeps Rust errors visible)
    clearScreen: false,

    // Resolve aliases for cleaner imports
    resolve: {
      dedupe: [
        "react",
        "react-dom",
        "@codemirror/autocomplete",
        "@codemirror/commands",
        "@codemirror/language",
        "@codemirror/lint",
        "@codemirror/search",
        "@codemirror/state",
        "@codemirror/view",
      ],
      alias: {
        "@": "/src",
        "@components": "/src/components",
        "@stores": "/src/stores",
        "@services": "/src/services",
        "@utils": "/src/utils",
        "@types": "/src/types",
        "@hooks": "/src/hooks",
      },
    },

    // CSS configuration
    css: {
      devSourcemap: true,
      modules: {
        localsConvention: "camelCase",
      },
    },

    // Preview server configuration
    preview: {
      port: 1422,
      strictPort: true,
    },
  };
});
