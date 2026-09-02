#!/bin/sh

# Build a byte-for-byte reproducible unpacked-extension ZIP and SHA-256 file.
# Usage: sh scripts/package-extension.sh [output-directory]

set -eu
export LC_ALL=C
export TZ=UTC

for required_command in node zip unzip; do
  if ! command -v "$required_command" >/dev/null 2>&1; then
    printf 'Required packaging command is unavailable: %s\n' "$required_command" >&2
    exit 1
  fi
done

SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
ROOT_DIR=$(CDPATH= cd -- "$SCRIPT_DIR/.." && pwd)
OUTPUT_DIR=${1:-"$ROOT_DIR/dist"}

case "$OUTPUT_DIR" in
  /*) ;;
  *) OUTPUT_DIR="$(pwd)/$OUTPUT_DIR" ;;
esac

VERSION_NAME=$(node -e "const fs=require('fs');const m=JSON.parse(fs.readFileSync(process.argv[1],'utf8'));const v=String(m.version_name||'');if(!/^\\d+\\.\\d+\\.\\d+(?:-[0-9A-Za-z]+(?:[.-][0-9A-Za-z]+)*)?$/.test(v)){console.error('Invalid or missing manifest version_name: '+v);process.exit(1)}process.stdout.write(v);" "$ROOT_DIR/manifest.json")

ARCHIVE_BASE="swipe-for-letterboxd-v$VERSION_NAME"
ARCHIVE_PATH="$OUTPUT_DIR/$ARCHIVE_BASE.zip"
CHECKSUM_PATH="$OUTPUT_DIR/$ARCHIVE_BASE.sha256"
STAGING_DIR=$(mktemp -d "${TMPDIR:-/tmp}/swipe-extension-package.XXXXXX")
trap 'rm -rf "$STAGING_DIR"' EXIT HUP INT TERM

PACKAGE_FILES='manifest.json
background.js
content.js
film-state.js
popup.html
popup.js
styles.css
icons/icon16.png
icons/icon48.png
icons/icon128.png'

mkdir -p "$OUTPUT_DIR" "$STAGING_DIR/icons"
chmod 0755 "$STAGING_DIR" "$STAGING_DIR/icons"

printf '%s\n' "$PACKAGE_FILES" | while IFS= read -r relative_path; do
  [ -n "$relative_path" ] || continue
  source_path="$ROOT_DIR/$relative_path"
  if [ ! -f "$source_path" ]; then
    printf 'Required package file is missing: %s\n' "$relative_path" >&2
    exit 1
  fi
  cp "$source_path" "$STAGING_DIR/$relative_path"
  chmod 0644 "$STAGING_DIR/$relative_path"
  touch -t 202001010000.00 "$STAGING_DIR/$relative_path"
done

rm -f "$ARCHIVE_PATH" "$CHECKSUM_PATH"
(
  cd "$STAGING_DIR"
  printf '%s\n' "$PACKAGE_FILES" | sort | zip -X -q "$ARCHIVE_PATH" -@
)

unzip -tq "$ARCHIVE_PATH" >/dev/null

if command -v shasum >/dev/null 2>&1; then
  (cd "$OUTPUT_DIR" && shasum -a 256 "$ARCHIVE_BASE.zip") > "$CHECKSUM_PATH"
elif command -v sha256sum >/dev/null 2>&1; then
  (cd "$OUTPUT_DIR" && sha256sum "$ARCHIVE_BASE.zip") > "$CHECKSUM_PATH"
else
  printf 'Neither shasum nor sha256sum is available.\n' >&2
  exit 1
fi

printf 'Created %s\n' "$ARCHIVE_PATH"
printf 'Created %s\n' "$CHECKSUM_PATH"
cat "$CHECKSUM_PATH"
