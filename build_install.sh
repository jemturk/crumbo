#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")/android"

usage() {
  echo "Usage: $0 (-apk|-aab) [-i]" >&2
  echo "  -apk  build the release APK and install it" >&2
  echo "  -aab  build the release AAB" >&2
  echo "  -i    skip building — just install the APK already built in this dir (requires -apk)" >&2
  exit 1
}

MODE=""
INSTALL_ONLY=false

for arg in "$@"; do
  case "$arg" in
    -apk) [[ -n "$MODE" && "$MODE" != "apk" ]] && usage; MODE="apk" ;;
    -aab) [[ -n "$MODE" && "$MODE" != "aab" ]] && usage; MODE="aab" ;;
    -i) INSTALL_ONLY=true ;;
    *) usage ;;
  esac
done

[[ -z "$MODE" ]] && usage
if [[ "$MODE" == "aab" && "$INSTALL_ONLY" == true ]]; then
  echo "Error: -i isn't supported with -aab — an .aab can't be installed directly via adb." >&2
  exit 1
fi

APK_PATH="$(pwd)/app/build/outputs/apk/release/app-release.apk"
AAB_PATH="$(pwd)/app/build/outputs/bundle/release/app-release.aab"

if [[ "$MODE" == "apk" ]]; then
  [[ "$INSTALL_ONLY" == false ]] && ./gradlew assembleRelease
  adb install -r "$APK_PATH"
else
  ./gradlew bundleRelease
  echo "Built AAB: $AAB_PATH"
fi
