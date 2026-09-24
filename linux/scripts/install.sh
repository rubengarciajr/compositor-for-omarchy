#!/usr/bin/env bash
# Build, self-test and (re)install Compositor as a pacman package on Arch / Omarchy.
#
#   linux/scripts/install.sh          # typecheck + build + headless self-test, then makepkg -si
#   linux/scripts/install.sh --no-test
#
# The self-test runs first so a broken build never reaches /usr/share/compositor.
set -euo pipefail

LINUX_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$LINUX_DIR"

if [[ "${1:-}" == "--no-test" ]]; then
  npm install && npm run build
else
  npm install && npm run check
fi

cd packaging
rm -rf pkg src
makepkg -sif --noconfirm

echo
echo "Installed $(pacman -Q compositor). Launch it from the app menu (Super + Space → Compositor) or run: compositor"
echo "A running Compositor window keeps the old code — close it and launch again."
