#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")/android"
./gradlew assembleRelease && adb install -r "$(pwd)/app/build/outputs/apk/release/app-release.apk"
