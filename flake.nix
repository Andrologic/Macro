{
  description = "Macro - Tauri + React + TypeScript application";

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
        
        rustToolchain = pkgs.rust-bin.stable.latest.default.override {
          extensions = [ "rust-src" "rust-analyzer" ];
        };
      in
      {
        devShells.default = pkgs.mkShell {
          buildInputs = with pkgs; [
            rustToolchain
            rustc
            cargo
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
            nodejs_22
            pnpm
            libiconv
            llvmPackages.clang
            mold
          ];

          shellHook = ''
            # Set environment variables for Rust
            export RUST_SRC_PATH="${rustToolchain}/lib/rustlib/src/rust/library"
            
            # Set PKG_CONFIG_PATH for Tauri dependencies
            export PKG_CONFIG_PATH="${pkgs.lib.makeSearchPath "lib/pkgconfig" [pkgs.webkitgtk_4_1 pkgs.libayatana-appindicator pkgs.openssl_3 pkgs.librsvg pkgs.curl pkgs.wget pkgs.file pkgs.xdotool pkgs.gdk-pixbuf pkgs.gtk3 pkgs.pango pkgs.cairo pkgs.glib pkgs.glib-networking pkgs.dbus]}"
            
            # Add Node.js and pnpm to PATH
            export PATH="${pkgs.nodejs_22}/bin:${pkgs.pnpm}/bin:$PATH"
            
            # Use mold for faster linking on Linux
            if [ -f "${pkgs.mold}/bin/mold" ]; then
              export RUSTFLAGS="-C link-arg=-fuse-ld=mold"
            fi
            
            echo "🦀 Rust: $(rustc --version)"
            echo "📦 Cargo: $(cargo --version)"
            echo "📦 Node: $(node --version)"
            echo "📦 pnpm: $(pnpm --version)"
            echo ""
            echo "🚀 Environment ready for Tauri development!"
            echo ""
            echo "Available commands:"
            echo "  pnpm install     - Install dependencies"
            echo "  pnpm dev         - Start development server"
            echo "  pnpm build       - Build for production"
            echo "  pnpm tauri dev   - Run Tauri in development mode"
            echo "  pnpm tauri build - Build Tauri application"
          '';
        };

        # Optional: Provide the ability to build the project
        packages.default = pkgs.stdenv.mkDerivation {
          pname = "macro";
          version = "0.1.0";
          
          src = ./.;
          
          nativeBuildInputs = with pkgs; [
            rustToolchain
            cargo
            nodejs_22
            pnpm
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
            
            # Install Node.js dependencies
            pnpm install --frozen-lockfile
            
            # Build the Tauri application
            pnpm tauri build
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
