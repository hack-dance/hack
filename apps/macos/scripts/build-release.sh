#!/bin/bash
set -euo pipefail

# Build, sign, notarize, and package Hack Desktop for release
#
# Prerequisites:
#   - Xcode with Developer ID Application certificate in keychain
#   - App-specific password for notarization
#
# Environment variables (or will prompt):
#   APPLE_ID          - Your Apple ID email
#   APPLE_ID_PASSWORD - App-specific password (create at appleid.apple.com)
#   APPLE_TEAM_ID     - Your Apple Developer Team ID
#
# Usage:
#   ./scripts/build-release.sh
#   APPLE_ID=you@example.com APPLE_TEAM_ID=XXXXXXXXXX ./scripts/build-release.sh

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
BUILD_DIR="$PROJECT_DIR/build"
APP_NAME="Hack Desktop"
SCHEME="HackDesktop"

# Load .env.local if it exists
if [ -f "$PROJECT_DIR/.env.local" ]; then
  set -a
  source "$PROJECT_DIR/.env.local"
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
command -v xcodebuild >/dev/null || error "xcodebuild not found. Install Xcode."
command -v xcrun >/dev/null || error "xcrun not found. Install Xcode Command Line Tools."

# Prompt for credentials if not set
if [ -z "${APPLE_ID:-}" ]; then
  read -p "Apple ID (email): " APPLE_ID
fi

if [ -z "${APPLE_ID_PASSWORD:-}" ]; then
  echo "App-specific password (create at appleid.apple.com → Sign-In & Security → App-Specific Passwords)"
  read -sp "Password: " APPLE_ID_PASSWORD
  echo
fi

if [ -z "${APPLE_TEAM_ID:-}" ]; then
  read -p "Apple Team ID: " APPLE_TEAM_ID
fi

# Clean build directory
log "Cleaning build directory..."
rm -rf "$BUILD_DIR"
mkdir -p "$BUILD_DIR"

# Generate Xcode project if needed
if [ ! -f "$PROJECT_DIR/HackDesktop.xcodeproj/project.pbxproj" ]; then
  log "Generating Xcode project..."
  cd "$PROJECT_DIR"
  xcodegen generate
fi

# Build and archive
log "Building and archiving..."
cd "$PROJECT_DIR"
xcodebuild archive \
  -scheme "$SCHEME" \
  -configuration Release \
  -archivePath "$BUILD_DIR/HackDesktop.xcarchive" \
  CODE_SIGN_STYLE=Manual \
  CODE_SIGN_IDENTITY="Developer ID Application" \
  DEVELOPMENT_TEAM="$APPLE_TEAM_ID" \
  | xcbeautify 2>/dev/null || xcodebuild archive \
    -scheme "$SCHEME" \
    -configuration Release \
    -archivePath "$BUILD_DIR/HackDesktop.xcarchive" \
    CODE_SIGN_STYLE=Manual \
    CODE_SIGN_IDENTITY="Developer ID Application" \
    DEVELOPMENT_TEAM="$APPLE_TEAM_ID"

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
log "Submitting app for notarization (this may take a few minutes)..."
ditto -c -k --keepParent "$BUILD_DIR/export/$APP_NAME.app" "$BUILD_DIR/app.zip"

xcrun notarytool submit "$BUILD_DIR/app.zip" \
  --apple-id "$APPLE_ID" \
  --password "$APPLE_ID_PASSWORD" \
  --team-id "$APPLE_TEAM_ID" \
  --wait

success "App notarized"

# Staple notarization ticket
log "Stapling notarization ticket to app..."
xcrun stapler staple "$BUILD_DIR/export/$APP_NAME.app"
success "Ticket stapled"

# Get version
VERSION=$(defaults read "$BUILD_DIR/export/$APP_NAME.app/Contents/Info.plist" CFBundleShortVersionString)
log "Version: $VERSION"

# Create DMG
log "Creating DMG..."
if command -v create-dmg >/dev/null; then
  create-dmg \
    --volname "$APP_NAME" \
    --window-pos 200 120 \
    --window-size 600 400 \
    --icon-size 100 \
    --icon "$APP_NAME.app" 150 190 \
    --app-drop-link 450 190 \
    --hide-extension "$APP_NAME.app" \
    "$BUILD_DIR/HackDesktop-$VERSION-macOS.dmg" \
    "$BUILD_DIR/export/$APP_NAME.app" || true
fi

# Fallback to hdiutil if create-dmg failed or not installed
if [ ! -f "$BUILD_DIR/HackDesktop-$VERSION-macOS.dmg" ]; then
  hdiutil create -volname "$APP_NAME" \
    -srcfolder "$BUILD_DIR/export/$APP_NAME.app" \
    -ov -format UDZO \
    "$BUILD_DIR/HackDesktop-$VERSION-macOS.dmg"
fi

success "DMG created"

# Notarize DMG
log "Submitting DMG for notarization..."
xcrun notarytool submit "$BUILD_DIR/HackDesktop-$VERSION-macOS.dmg" \
  --apple-id "$APPLE_ID" \
  --password "$APPLE_ID_PASSWORD" \
  --team-id "$APPLE_TEAM_ID" \
  --wait

xcrun stapler staple "$BUILD_DIR/HackDesktop-$VERSION-macOS.dmg"
success "DMG notarized and stapled"

# Create ZIP
log "Creating ZIP..."
ditto -c -k --keepParent \
  "$BUILD_DIR/export/$APP_NAME.app" \
  "$BUILD_DIR/HackDesktop-$VERSION-macOS.zip"
success "ZIP created"

# Summary
echo
echo -e "${GREEN}Build complete!${NC}"
echo
echo "Artifacts:"
echo "  $BUILD_DIR/HackDesktop-$VERSION-macOS.dmg"
echo "  $BUILD_DIR/HackDesktop-$VERSION-macOS.zip"
echo "  $BUILD_DIR/export/$APP_NAME.app"
echo
echo "To install locally:"
echo "  open \"$BUILD_DIR/HackDesktop-$VERSION-macOS.dmg\""
echo
echo "To upload to a GitHub release:"
echo "  gh release upload vX.X.X \"$BUILD_DIR/HackDesktop-$VERSION-macOS.dmg\" \"$BUILD_DIR/HackDesktop-$VERSION-macOS.zip\""
