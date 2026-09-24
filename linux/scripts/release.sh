#!/usr/bin/env bash
# Build a release of Compositor for Omarchy: a prebuilt tarball (no Node needed to install)
# plus the matching PKGBUILD for the AUR. Output lands in linux/release/.
#
#   scripts/release.sh            # runs the checks, builds, packs, prints the sha256
#   scripts/release.sh --no-check # skip typecheck + self-test (faster, for local trials)
#
# Then: tag `linux-v<version>`, upload release/<name>-<version>.tar.gz to the GitHub release,
# and publish release/PKGBUILD to the AUR (its sha256 and URL are already filled in).
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/.."

VERSION="$(node -p "require('./package.json').version")"
NAME="compositor-for-omarchy"
PROJECT_URL="$(node -p "require('./package.json').homepage || ''")"
[[ -z "$PROJECT_URL" ]] && PROJECT_URL="$(grep -oP 'PROJECT_URL: string = "\K[^"]+' src/app-info.ts)"
OUT="release"
STAGE="$OUT/$NAME-$VERSION"

if [[ "${1:-}" != "--no-check" ]]; then
  rm -f public/omarchy-theme.json public/colors.toml
  npm run check
else
  rm -f public/omarchy-theme.json public/colors.toml
  npm run build
fi

rm -rf "$STAGE" "$OUT/$NAME-$VERSION.tar.gz"
mkdir -p "$STAGE/bin" "$STAGE/share/icons" "$STAGE/docs"
cp -r dist "$STAGE/dist"
cp scripts/compositor "$STAGE/bin/compositor"
cp packaging/compositor.desktop packaging/compositor-project.xml "$STAGE/share/"
cp packaging/icons/compositor-*.png "$STAGE/share/icons/"
cp README.md "$STAGE/README.md"
cp ../LICENSE "$STAGE/LICENSE"
cp ../docs/linux-changelog.md ../docs/omarchy-upgrades.md ../docs/project-format.md "$STAGE/docs/"
chmod -R u=rwX,go=rX "$STAGE"

# Reproducible tarball: fixed owner, order and mtime (the version's commit-less stand-in: build date).
tar --sort=name --owner=0 --group=0 --numeric-owner --mtime="@${SOURCE_DATE_EPOCH:-0}" \
    -C "$OUT" -czf "$OUT/$NAME-$VERSION.tar.gz" "$NAME-$VERSION"
SHA="$(sha256sum "$OUT/$NAME-$VERSION.tar.gz" | cut -d' ' -f1)"
sed -e "s|@VERSION@|$VERSION|g" -e "s|@SHA256@|$SHA|g" -e "s|@PROJECT_URL@|$PROJECT_URL|g" \
    packaging/PKGBUILD.release > "$OUT/PKGBUILD"
rm -rf "$STAGE"

echo
echo "Release $NAME $VERSION"
echo "  tarball : $OUT/$NAME-$VERSION.tar.gz ($(du -h "$OUT/$NAME-$VERSION.tar.gz" | cut -f1))"
echo "  sha256  : $SHA"
echo "  PKGBUILD: $OUT/PKGBUILD  (source URL: $PROJECT_URL/releases/download/linux-v$VERSION/)"
