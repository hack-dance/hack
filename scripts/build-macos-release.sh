#!/bin/bash
set -euo pipefail

# Unified macOS release builder
# Builds CLI + macOS app, creates a single DMG with both
#
# Usage:
#   ./scripts/build-macos-release.sh [--skip-cli] [--skip-notarize]

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
MACOS_APP_DIR="$REPO_ROOT/apps/macos"
BUILD_DIR="$REPO_ROOT/dist/macos-release"
APP_NAME="Hack Desktop"
SCHEME="HackDesktop"

# Parse args
SKIP_CLI=false
SKIP_NOTARIZE=false
for arg in "$@"; do
  case $arg in
    --skip-cli) SKIP_CLI=true ;;
    --skip-notarize) SKIP_NOTARIZE=true ;;
    --help|-h)
      echo "Usage: $0 [--skip-cli] [--skip-notarize]"
      exit 0
      ;;
  esac
done

# Load credentials from macOS app .env.local
if [ -f "$MACOS_APP_DIR/.env.local" ]; then
  set -a
  source "$MACOS_APP_DIR/.env.local"
  set +a
fi

# Colors
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[0;33m'
BLUE='\033[0;34m'
NC='\033[0m'

log() { echo -e "${BLUE}==>${NC} $1"; }
success() { echo -e "${GREEN}✓${NC} $1"; }
warn() { echo -e "${YELLOW}⚠${NC} $1"; }
error() { echo -e "${RED}✗${NC} $1" >&2; exit 1; }

# Check prerequisites
command -v bun >/dev/null || error "bun not found"
command -v xcodebuild >/dev/null || error "xcodebuild not found"

# Get version from package.json
VERSION=$(bun -e "const pkg = await Bun.file('$REPO_ROOT/package.json').json(); console.log(pkg.version)")
log "Version: $VERSION"

# Sync version to macOS app
log "Syncing version to macOS app..."
sed -i '' "s/^MARKETING_VERSION = .*/MARKETING_VERSION = $VERSION/" "$MACOS_APP_DIR/Config/Base.xcconfig"
success "Version synced to Base.xcconfig"

# Clean build directory
log "Cleaning build directory..."
rm -rf "$BUILD_DIR"
mkdir -p "$BUILD_DIR"

# Build CLI
if [ "$SKIP_CLI" = false ]; then
  log "Building CLI..."
  cd "$REPO_ROOT"

  CLI_BUILD_DIR="$BUILD_DIR/cli"
  mkdir -p "$CLI_BUILD_DIR"

  # Build binary
  bun build index.ts --compile --outfile "$CLI_BUILD_DIR/hack"

  # Sign CLI binary with hardened runtime (required for notarization)
  # Find the Developer ID Application certificate
  SIGNING_IDENTITY=$(security find-identity -v -p codesigning | awk '/Developer ID Application/ {print $2; exit}')
  if [ -z "$SIGNING_IDENTITY" ]; then
    error "No Developer ID Application certificate found"
  fi
  log "Signing CLI binary with certificate: $SIGNING_IDENTITY"
  codesign --force --options runtime --timestamp \
    --entitlements "$SCRIPT_DIR/cli.entitlements" \
    --sign "$SIGNING_IDENTITY" \
    "$CLI_BUILD_DIR/hack"

  # Verify signature
  codesign -vvv --deep --strict "$CLI_BUILD_DIR/hack"
  success "CLI binary signed and verified"

  # Copy assets
  ASSETS_DIR="$CLI_BUILD_DIR/assets"
  mkdir -p "$ASSETS_DIR/gifs" "$ASSETS_DIR/schemas"

  [ -f "$REPO_ROOT/assets/cut.gif" ] && cp "$REPO_ROOT/assets/cut.gif" "$ASSETS_DIR/gifs/"
  [ -f "$REPO_ROOT/assets/hacker-mash.gif" ] && cp "$REPO_ROOT/assets/hacker-mash.gif" "$ASSETS_DIR/gifs/"

  # Copy and sign gum binaries if present
  if [ -d "$REPO_ROOT/binaries/gum" ]; then
    mkdir -p "$CLI_BUILD_DIR/binaries/gum"
    cp -R "$REPO_ROOT/binaries/gum/." "$CLI_BUILD_DIR/binaries/gum/"

    # Sign gum binaries with hardened runtime
    log "Signing gum binaries..."
    find "$CLI_BUILD_DIR/binaries/gum" -type f -perm +111 | while read -r binary; do
      codesign --force --options runtime --timestamp \
        --sign "$SIGNING_IDENTITY" \
        "$binary" 2>/dev/null || true
    done
    success "Gum binaries signed"
  fi

  success "CLI built"
else
  warn "Skipping CLI build"
fi

# Generate Xcode project
log "Generating Xcode project..."
cd "$MACOS_APP_DIR"
xcodegen generate
success "Xcode project generated"

# Build and archive macOS app
log "Building and archiving macOS app..."
xcodebuild archive \
  -scheme "$SCHEME" \
  -configuration Release \
  -archivePath "$BUILD_DIR/HackDesktop.xcarchive" \
  CODE_SIGN_STYLE=Manual \
  CODE_SIGN_IDENTITY="Developer ID Application" \
  DEVELOPMENT_TEAM="$APPLE_TEAM_ID" \
  MARKETING_VERSION="$VERSION" \
  | xcbeautify 2>/dev/null || xcodebuild archive \
    -scheme "$SCHEME" \
    -configuration Release \
    -archivePath "$BUILD_DIR/HackDesktop.xcarchive" \
    CODE_SIGN_STYLE=Manual \
    CODE_SIGN_IDENTITY="Developer ID Application" \
    DEVELOPMENT_TEAM="$APPLE_TEAM_ID" \
    MARKETING_VERSION="$VERSION"

success "Archive created"

# Export app
log "Exporting app..."
cat > "$BUILD_DIR/ExportOptions.plist" << EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>method</key>
    <string>developer-id</string>
    <key>teamID</key>
    <string>$APPLE_TEAM_ID</string>
    <key>signingStyle</key>
    <string>manual</string>
    <key>signingCertificate</key>
    <string>Developer ID Application</string>
</dict>
</plist>
EOF

xcodebuild -exportArchive \
  -archivePath "$BUILD_DIR/HackDesktop.xcarchive" \
  -exportPath "$BUILD_DIR/export" \
  -exportOptionsPlist "$BUILD_DIR/ExportOptions.plist"

success "App exported"

# Verify signature
log "Verifying code signature..."
codesign -vvv --deep --strict "$BUILD_DIR/export/$APP_NAME.app"
success "Code signature valid"

# Notarize app
if [ "$SKIP_NOTARIZE" = false ]; then
  log "Submitting app for notarization..."
  ditto -c -k --keepParent "$BUILD_DIR/export/$APP_NAME.app" "$BUILD_DIR/app.zip"

  xcrun notarytool submit "$BUILD_DIR/app.zip" \
    --apple-id "$APPLE_ID" \
    --password "$APPLE_ID_PASSWORD" \
    --team-id "$APPLE_TEAM_ID" \
    --wait

  xcrun stapler staple "$BUILD_DIR/export/$APP_NAME.app"
  success "App notarized and stapled"
else
  warn "Skipping notarization"
fi

# Prepare DMG contents
log "Preparing DMG contents..."
DMG_CONTENTS="$BUILD_DIR/dmg-contents"
mkdir -p "$DMG_CONTENTS"

# Copy app
cp -R "$BUILD_DIR/export/$APP_NAME.app" "$DMG_CONTENTS/"

# Copy CLI and create installer script
if [ "$SKIP_CLI" = false ]; then
  mkdir -p "$DMG_CONTENTS/.hack-cli"
  cp "$CLI_BUILD_DIR/hack" "$DMG_CONTENTS/.hack-cli/"
  [ -d "$CLI_BUILD_DIR/assets" ] && cp -R "$CLI_BUILD_DIR/assets" "$DMG_CONTENTS/.hack-cli/"
  [ -d "$CLI_BUILD_DIR/binaries" ] && cp -R "$CLI_BUILD_DIR/binaries" "$DMG_CONTENTS/.hack-cli/"

  # Create clickable installer
  cat > "$DMG_CONTENTS/Install Hack CLI.command" << 'INSTALLER_EOF'
#!/bin/bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CLI_DIR="$SCRIPT_DIR/.hack-cli"
INSTALL_BIN="${HACK_INSTALL_BIN:-$HOME/.hack/bin}"
INSTALL_ASSETS="${HACK_INSTALL_ASSETS:-$HOME/.hack/assets}"

echo "Installing Hack CLI..."
echo

mkdir -p "$INSTALL_BIN" "$INSTALL_ASSETS"

# Copy binary
cp "$CLI_DIR/hack" "$INSTALL_BIN/hack"
chmod +x "$INSTALL_BIN/hack"

# Copy assets
if [ -d "$CLI_DIR/assets" ]; then
  cp -R "$CLI_DIR/assets/." "$INSTALL_ASSETS/"
fi

# Copy binaries
if [ -d "$CLI_DIR/binaries" ]; then
  mkdir -p "$INSTALL_ASSETS/binaries"
  cp -R "$CLI_DIR/binaries/." "$INSTALL_ASSETS/binaries/"
fi

echo "✓ Installed hack to $INSTALL_BIN/hack"

# Update PATH if needed
if [[ ":$PATH:" != *":$INSTALL_BIN:"* ]]; then
  shell_name="$(basename "${SHELL:-}")"
  if [ "$shell_name" = "zsh" ]; then
    rc_file="$HOME/.zshrc"
  elif [ "$shell_name" = "bash" ]; then
    rc_file="$HOME/.bashrc"
  else
    rc_file="$HOME/.profile"
  fi

  line="export PATH=\"$INSTALL_BIN:\$PATH\""
  assets_line="export HACK_ASSETS_DIR=\"$INSTALL_ASSETS\""

  if [ -f "$rc_file" ] && ! grep -Fq "$line" "$rc_file"; then
    echo "$line" >> "$rc_file"
    echo "✓ Added hack to PATH in $rc_file"
  fi

  if [ -f "$rc_file" ] && ! grep -Fq "$assets_line" "$rc_file"; then
    echo "$assets_line" >> "$rc_file"
  fi
fi

echo
echo "Installation complete!"
echo
echo "Open a new terminal and run: hack --help"
echo
read -p "Press Enter to close..."
INSTALLER_EOF
  chmod +x "$DMG_CONTENTS/Install Hack CLI.command"

  # Sign the .command file with Developer ID (required for Gatekeeper)
  log "Signing Install Hack CLI.command..."
  codesign --force --options runtime --timestamp \
    --sign "$SIGNING_IDENTITY" \
    "$DMG_CONTENTS/Install Hack CLI.command"
  codesign -vvv "$DMG_CONTENTS/Install Hack CLI.command"
  success "Install script signed"
fi

# Create Applications symlink
ln -s /Applications "$DMG_CONTENTS/Applications"

success "DMG contents prepared"

# Create DMG
log "Creating DMG..."
DMG_PATH="$BUILD_DIR/Hack-$VERSION-macOS.dmg"

if command -v create-dmg >/dev/null; then
  create-dmg \
    --volname "Hack $VERSION" \
    --window-pos 200 120 \
    --window-size 660 400 \
    --icon-size 100 \
    --icon "$APP_NAME.app" 180 190 \
    --icon "Install Hack CLI.command" 330 190 \
    --app-drop-link 480 190 \
    --hide-extension "$APP_NAME.app" \
    --hide-extension "Install Hack CLI.command" \
    "$DMG_PATH" \
    "$DMG_CONTENTS" || true
fi

# Fallback to hdiutil
if [ ! -f "$DMG_PATH" ]; then
  hdiutil create -volname "Hack $VERSION" \
    -srcfolder "$DMG_CONTENTS" \
    -ov -format UDZO \
    "$DMG_PATH"
fi

success "DMG created"

# Notarize DMG
if [ "$SKIP_NOTARIZE" = false ]; then
  log "Notarizing DMG..."
  xcrun notarytool submit "$DMG_PATH" \
    --apple-id "$APPLE_ID" \
    --password "$APPLE_ID_PASSWORD" \
    --team-id "$APPLE_TEAM_ID" \
    --wait

  xcrun stapler staple "$DMG_PATH"
  success "DMG notarized and stapled"
fi

# Also create standalone ZIP of app
log "Creating app ZIP..."
ditto -c -k --keepParent \
  "$BUILD_DIR/export/$APP_NAME.app" \
  "$BUILD_DIR/HackDesktop-$VERSION-macOS.zip"
success "ZIP created"

# Generate hack-install.sh (download installer script)
log "Generating hack-install.sh..."
INSTALL_SCRIPT_PATH="$BUILD_DIR/hack-install.sh"
INSTALL_SCRIPT_VERSIONED="$BUILD_DIR/hack-$VERSION-install.sh"
cat > "$INSTALL_SCRIPT_PATH" << 'DOWNLOAD_INSTALLER_EOF'
#!/usr/bin/env bash
set -euo pipefail

REPO_OWNER="hack-dance"
REPO_NAME="hack-cli"
REPO="$REPO_OWNER/$REPO_NAME"
API_URL="https://api.github.com/repos/$REPO/releases/latest"
BASE_URL="${HACK_RELEASE_BASE_URL:-https://github.com/$REPO/releases/download}"

if [ -n "${HACK_INSTALL_TAG:-}" ]; then
  TAG="$HACK_INSTALL_TAG"
elif [ -n "${HACK_INSTALL_VERSION:-}" ]; then
  TAG="v$HACK_INSTALL_VERSION"
else
  TAG=$(curl -fsSL "$API_URL" | sed -n 's/.*"tag_name": "\([^"]*\)".*/\1/p' | head -n1)
fi

if [ -z "$TAG" ]; then
  echo "Failed to resolve release tag."
  exit 1
fi

VERSION="${TAG#v}"
OS="$(uname -s | tr '[:upper:]' '[:lower:]')"
ARCH="$(uname -m)"
if [ "$ARCH" = "x86_64" ] || [ "$ARCH" = "amd64" ]; then
  ARCH="x86_64"
elif [ "$ARCH" = "arm64" ] || [ "$ARCH" = "aarch64" ]; then
  ARCH="arm64"
else
  echo "Unsupported architecture: $ARCH"
  exit 1
fi

if [ "$OS" != "darwin" ] && [ "$OS" != "linux" ]; then
  echo "Unsupported OS: $OS"
  exit 1
fi

TARBALL="hack-$VERSION-$OS-$ARCH.tar.gz"
URL="$BASE_URL/$TAG/$TARBALL"

tmpdir=$(mktemp -d)
cleanup() { rm -rf "$tmpdir"; }
trap cleanup EXIT

echo "Downloading $URL"
curl -fsSL "$URL" -o "$tmpdir/$TARBALL"
tar -xzf "$tmpdir/$TARBALL" -C "$tmpdir"

INSTALL_DIR="$tmpdir/hack-$VERSION-release"
if [ ! -d "$INSTALL_DIR" ]; then
  echo "Missing release directory: $INSTALL_DIR"
  exit 1
fi

bash "$INSTALL_DIR/install.sh"
DOWNLOAD_INSTALLER_EOF
chmod +x "$INSTALL_SCRIPT_PATH"
cp "$INSTALL_SCRIPT_PATH" "$INSTALL_SCRIPT_VERSIONED"
success "hack-install.sh created"

# Summary
echo
echo -e "${GREEN}Release build complete!${NC}"
echo
echo "Version: $VERSION"
echo
echo "Artifacts:"
echo "  $DMG_PATH"
echo "  $BUILD_DIR/HackDesktop-$VERSION-macOS.zip"
echo "  $INSTALL_SCRIPT_PATH"
echo "  $INSTALL_SCRIPT_VERSIONED"
echo
echo "To install:"
echo "  open \"$DMG_PATH\""
echo
echo "To upload to GitHub release:"
echo "  gh release upload v$VERSION \\"
echo "    \"$DMG_PATH\" \\"
echo "    \"$BUILD_DIR/HackDesktop-$VERSION-macOS.zip\" \\"
echo "    \"$INSTALL_SCRIPT_PATH\" \\"
echo "    \"$INSTALL_SCRIPT_VERSIONED\""
