#!/usr/bin/env bash
# Stint installer / updater.
#
#   curl -fsSL https://raw.githubusercontent.com/PierrickMartos/stint/main/scripts/install.sh | bash
#
# Downloads the latest release DMG from GitHub, installs Stint.app into
# /Applications, and replaces any previous version. Run it again any time
# to update. Because the download happens via curl (not a browser), the app
# arrives without Gatekeeper's quarantine flag.
set -euo pipefail

REPO="PierrickMartos/stint"
APP_NAME="Stint"
DEST="/Applications/${APP_NAME}.app"

echo "▸ Looking up the latest ${APP_NAME} release…"
DMG_URL=$(curl -fsSL "https://api.github.com/repos/${REPO}/releases/latest" \
  | grep -o '"browser_download_url": *"[^"]*\.dmg"' \
  | head -1 \
  | sed 's/.*"\(https[^"]*\)"/\1/')

if [ -z "${DMG_URL}" ]; then
  echo "✗ Could not find a .dmg asset in the latest release of ${REPO}." >&2
  exit 1
fi

TMP_DIR=$(mktemp -d)
trap 'rm -rf "${TMP_DIR}"; hdiutil detach "${MOUNT_POINT:-}" >/dev/null 2>&1 || true' EXIT

echo "▸ Downloading $(basename "${DMG_URL}")…"
curl -fL --progress-bar -o "${TMP_DIR}/stint.dmg" "${DMG_URL}"

echo "▸ Mounting…"
MOUNT_POINT=$(hdiutil attach -nobrowse -readonly "${TMP_DIR}/stint.dmg" \
  | grep -o '/Volumes/.*' | head -1)

if [ ! -d "${MOUNT_POINT}/${APP_NAME}.app" ]; then
  echo "✗ ${APP_NAME}.app not found inside the DMG." >&2
  exit 1
fi

# Stop a running instance before replacing it
if pgrep -xq "${APP_NAME}" 2>/dev/null; then
  echo "▸ Quitting the running ${APP_NAME}…"
  osascript -e "tell application \"${APP_NAME}\" to quit" >/dev/null 2>&1 || pkill -x "${APP_NAME}" || true
  sleep 1
fi

echo "▸ Installing to ${DEST}…"
rm -rf "${DEST}"
cp -R "${MOUNT_POINT}/${APP_NAME}.app" "${DEST}"

hdiutil detach "${MOUNT_POINT}" >/dev/null
MOUNT_POINT=""

# Belt and braces: clear quarantine if anything set it
xattr -dr com.apple.quarantine "${DEST}" 2>/dev/null || true

VERSION=$(defaults read "${DEST}/Contents/Info" CFBundleShortVersionString 2>/dev/null || echo "?")
echo "✓ ${APP_NAME} ${VERSION} installed. Launch it from /Applications or:"
echo "    open ${DEST}"
