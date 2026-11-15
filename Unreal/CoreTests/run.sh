#!/usr/bin/env bash
# Build and run the headless playthrough of the C++ simulation core
# (no Unreal needed). Run from anywhere:  Unreal/CoreTests/run.sh
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
root="$(cd "$here/../.." && pwd)"
core="$root/Unreal/Source/Skilandia/Core"
out="${TMPDIR:-/tmp}/skilandia-playthrough"
${CXX:-g++} -std=c++20 -O2 -Wall -Wextra -Wshadow -Werror -I"$core" "$core"/*.cpp "$here/Playthrough.cpp" -o "$out"
"$out" "$root/Unreal/Content/Data/Terrain.u16"
