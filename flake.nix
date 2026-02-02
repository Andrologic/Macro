{
  description = "Macro - Tauri + React + TypeScript application with Bun";

  inputs = {
    nixpkgs.url = "github:NixOS/nixpkgs/nixos-unstable";
    rust-overlay.url = "github:oxalica/rust-overlay";
    flake-utils.url = "github:numtide/flake-utils";
  };

  outputs = { self, nixpkgs, rust-overlay, flake-utils, ... }:
    flake-utils.lib.eachDefaultSystem (system:
      let
        overlays = [ (import rust-overlay) ];
        pkgs = import nixpkgs {
          inherit system overlays;
        };

        # Rust toolchain with src and analyzer
        rustToolchain = pkgs.rust-bin.stable.latest.default.override {
          extensions = [ "rust-src" "rust-analyzer" ];
        };
      in
      {
        devShells.default = pkgs.mkShell {
          buildInputs = with pkgs; [
            # Rust toolchain
            rustToolchain
            rustc
            cargo

            # Tauri dependencies
            webkitgtk_4_1
            libayatana-appindicator
            openssl_3
            librsvg
            curl
            wget
            file
            xdotool
            gdk-pixbuf
            gtk3
            pango
            cairo
            pkg-config
            glib
            glib-networking
            dbus

            # JavaScript runtime and package manager
            bun

            # Additional build tools
            libiconv
            llvmPackages.clang
            mold
          ];

          shellHook = ''
            # =============================================================================
            # RUST ENVIRONMENT
            # =============================================================================
            export RUST_SRC_PATH="${rustToolchain}/lib/rustlib/src/rust/library"

            # =============================================================================
            # PKG_CONFIG PATH - Tauri dependencies
            # =============================================================================
            export PKG_CONFIG_PATH="${pkgs.lib.makeSearchPath "lib/pkgconfig" [
              pkgs.webkitgtk_4_1
              pkgs.libayatana-appindicator
              pkgs.openssl_3
              pkgs.librsvg
              pkgs.curl
              pkgs.wget
              pkgs.file
              pkgs.xdotool
              pkgs.gdk-pixbuf
              pkgs.gtk3
              pkgs.pango
              pkgs.cairo
              pkgs.glib
              pkgs.glib-networking
              pkgs.dbus
            ]}"

            # =============================================================================
            # BUN CONFIGURATION
            # =============================================================================
            # Ensure Bun is available
            export BUN_INSTALL="$HOME/.bun"
            export PATH="$BUN_INSTALL/bin:$PATH"

            # =============================================================================
            # OPTIMIZATIONS
            # =============================================================================
            # Use mold for faster linking on Linux
            if [ -f "${pkgs.mold}/bin/mold" ]; then
              export RUSTFLAGS="-C link-arg=-fuse-ld=mold"
            fi

            # =============================================================================
            # BANNER
            # =============================================================================
            echo ""
            echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
            echo "  🦀 Macro Development Environment"
            echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
            echo "  Rust:   $(rustc --version)"
            echo "  Cargo:  $(cargo --version)"
            echo "  Bun:    $(bun --version)"
            echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
            echo ""
            echo "🚀 Available commands:"
            echo "  bun install          - Install dependencies"
            echo "  bun run dev          - Start development server"
            echo "  bun run build        - Build for production"
            echo "  bun run tauri dev    - Run Tauri in development mode"
            echo "  bun run tauri build  - Build Tauri application"
            echo "  bun run clean        - Clean all artifacts and cache"
            echo "  bun run typecheck    - Run TypeScript type checking"
            echo "  bun run lint         - Run ESLint"
            echo ""
          '';
        };

        # =============================================================================
        # BUILD PACKAGE - Optional: Build the project with Nix
        # =============================================================================
        packages.default = pkgs.stdenv.mkDerivation {
          pname = "macro";
          version = "0.1.0";

          src = ./.;

          nativeBuildInputs = with pkgs; [
            rustToolchain
            cargo
            bun
            pkg-config
            makeWrapper
          ];

          buildInputs = with pkgs; [
            webkitgtk_4_1
            libayatana-appindicator
            openssl_3
            librsvg
            curl
            wget
            file
            xdotool
            gdk-pixbuf
            gtk3
            pango
            cairo
            glib
            glib-networking
            dbus
          ];

          buildPhase = ''
            export HOME="$TMPDIR/home"
            mkdir -p "$HOME"

            # Install Bun dependencies
            bun install --frozen-lockfile

            # Build the Tauri application
            bun run tauri build
          '';

          installPhase = ''
            mkdir -p $out/bin

            # Find and copy the built executable
            find src-tauri/target/release -maxdepth 1 -type f -executable -name "macro" -exec cp {} $out/bin/macro \;

            # Make sure the binary is executable
            chmod +x $out/bin/macro
          '';
        };
      }
    );
}
