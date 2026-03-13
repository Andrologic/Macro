import { existsSync, readdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// @ts-expect-error process is a nodejs global
const host = process.env.TAURI_DEV_HOST;
const projectRoot = dirname(fileURLToPath(import.meta.url));
const ALLOWED_PUBLIC_SECRET_FILES = new Set(["ai-keys.local.example.json"]);

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
  if (command === "build") {
    validatePublicSecretFiles(projectRoot);
  }

  return {
  plugins: [
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

    // Use esbuild for faster minification (2-3x faster than terser)
    minify: "esbuild",

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
        manualChunks: {
          // React core - loaded first
          "react-vendor": ["react", "react-dom"],

          // State management
          "state-vendor": ["zustand", "jotai"],

          // UI Components - heavy dependencies
          "ui-vendor": [
            "@xyflow/react",
            "@dnd-kit/core",
            "@dnd-kit/sortable",
            "@dnd-kit/utilities",
          ],

          // Code editor - largest chunk, loaded on demand
          "editor-vendor": [
            "@codemirror/view",
            "@codemirror/state",
            "codemirror",
            "@codemirror/lang-javascript",
            "@codemirror/lang-rust",
            "@codemirror/theme-one-dark",
            "@codemirror/autocomplete",
            "@codemirror/commands",
            "@codemirror/lint",
          ],

          // Utilities
          "utils-vendor": [
            "i18next",
            "react-i18next",
            "i18next-browser-languagedetector",
            "lucide-react",
            "class-variance-authority",
            "clsx",
            "tailwind-merge",
          ],

          // Data fetching & streaming
          "data-vendor": [
            "@tauri-apps/api",
            "@tauri-apps/plugin-http",
            "@tauri-apps/plugin-store",
          ],
        },

        // Chunk naming strategy
        chunkFileNames: (chunkInfo) => {
          const facadeModuleId = chunkInfo.facadeModuleId
            ? chunkInfo.facadeModuleId.split('/').pop()?.replace(/\.[^/.]+$/, '')
            : 'chunk';
          return `assets/${facadeModuleId}-[hash].js`;
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

    // Reduce chunk size warnings
    chunkSizeWarningLimit: 1000,

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
      "react/jsx-runtime",
      "react/jsx-dev-runtime",
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
    port: 1420,
    strictPort: true,
    host: host || false,
    hmr: host
      ? {
        protocol: "ws",
        host,
        port: 1421,
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
    port: 1420,
    strictPort: true,
  },
  };
});
