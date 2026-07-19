#!/bin/sh
set -eu

BASE_URL=${AIDLC_RELEASE_BASE_URL:-https://github.com/awslabs/aidlc-workflows/releases}
VERSION=
FROM=
OFFLINE=0
CA_BUNDLE=${AIDLC_CA_BUNDLE:-}
HARNESSES=
MODE=human
YES=0
PROFILE=
PROGRESS_ACTIVE=0

clear_progress() {
  if [ "$PROGRESS_ACTIVE" -eq 1 ]; then
    printf '\r%-72s\r' "" >&2
    PROGRESS_ACTIVE=0
  fi
}

progress_start() {
  [ "$MODE" = "human" ] || return 0
  if [ -t 2 ]; then
    printf '\r%-72.72s' "Downloading $1..." >&2
    PROGRESS_ACTIVE=1
  fi
}

progress_done() {
  [ "$MODE" = "human" ] || return 0
  if [ -t 2 ]; then
    printf '\r%-72.72s\n' "Downloaded $1" >&2
    PROGRESS_ACTIVE=0
  else
    printf 'Downloaded %s\n' "$1" >&2
  fi
}

json_escape() {
  printf '%s' "$1" | awk 'BEGIN { ORS="" } {
    gsub(/\\/, "\\\\")
    gsub(/"/, "\\\"")
    for (i = 1; i < 32; i++) {
      gsub(sprintf("%c", i), sprintf("\\u%04x", i))
    }
    if (NR > 1) printf "\\n"
    printf "%s", $0
  }'
}

fail() {
  code=$1
  status=$2
  message=$3
  remediation=${4:-}
  clear_progress
  if [ "$MODE" = "json" ]; then
    printf '{"schemaVersion":1,"ok":false,"code":%s,"status":"%s","message":"%s"' \
      "$code" "$status" "$(json_escape "$message")"
    if [ -n "$remediation" ]; then
      printf ',"remediation":"%s"' "$(json_escape "$remediation")"
    fi
    printf '}\n'
  elif [ "$MODE" = "quiet" ]; then
    [ -z "$remediation" ] || message=$remediation
    printf '%s\n' "$message"
  else
    label=ERROR
    [ "$code" -ne 4 ] || label=FAIL
    printf '%s %s\n' "$label" "$message" >&2
    [ -z "$remediation" ] || printf 'Run: %s\n' "$remediation" >&2
  fi
  exit "$code"
}

usage_text() {
  echo "Usage: install.sh --harness <name> [--harness <name>...] [--version <x.y.z>] [--from <dir>] [--offline] [--profile <startup-file>] [--json|--quiet] [--no-color] [--yes]"
}

usage() {
  fail 2 usage "${1:-invalid arguments}" "$(usage_text)"
}

output_scan_expects_value=0
for arg in "$@"; do
  if [ "$output_scan_expects_value" -eq 1 ]; then
    output_scan_expects_value=0
    continue
  fi
  case "$arg" in
    --harness|--version|--from|--release-base-url|--ca-bundle|--profile)
      output_scan_expects_value=1
      ;;
    --json) MODE=json ;;
    --quiet) [ "$MODE" = "json" ] || MODE=quiet ;;
  esac
done

while [ "$#" -gt 0 ]; do
  case "$1" in
    --harness)
      [ "$#" -ge 2 ] || usage
      case "$2" in
        ""|-*|*[!a-z0-9-]*) usage "invalid harness name: $2" ;;
      esac
      HARNESSES="$HARNESSES $2"
      shift 2
      ;;
    --version) [ "$#" -ge 2 ] || usage; VERSION=$2; shift 2 ;;
    --from) [ "$#" -ge 2 ] || usage; FROM=$2; OFFLINE=1; shift 2 ;;
    --offline) OFFLINE=1; shift ;;
    --release-base-url) [ "$#" -ge 2 ] || usage; BASE_URL=$2; shift 2 ;;
    --ca-bundle) [ "$#" -ge 2 ] || usage; CA_BUNDLE=$2; shift 2 ;;
    --profile) [ "$#" -ge 2 ] || usage "--profile requires a startup file"; PROFILE=$2; shift 2 ;;
    --json) MODE=json; shift ;;
    --quiet) [ "$MODE" = "json" ] || MODE=quiet; shift ;;
    --no-color) shift ;;
    --yes) YES=1; shift ;;
    -h|--help) usage_text; exit 0 ;;
    *) usage "unknown argument: $1" ;;
  esac
done

[ -n "$HARNESSES" ] || [ -t 0 ] || usage "a harness is required in non-interactive installs; pass --harness <name>"
[ -n "$HARNESSES" ] || { [ "$MODE" = "human" ] && [ "$YES" -eq 0 ]; } ||
  usage "interactive harness selection is unavailable with --json, --quiet, or --yes; pass --harness <name>"
[ "$(id -u)" -ne 0 ] || fail 4 failed "refusing a root install; run as the target user"
if [ -n "$VERSION" ] && ! printf '%s\n' "$VERSION" | grep -Eq '^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$'; then
  usage "invalid --version: $VERSION"
fi
[ "$OFFLINE" -eq 0 ] || [ -n "$FROM" ] ||
  fail 3 unavailable "--offline requires --from <release-directory>"
if [ -z "$FROM" ]; then
  case "$BASE_URL" in
    *\?*|*\#*) fail 4 failed "release URL must not include credentials, a query, or a fragment" ;;
  esac
  release_authority=${BASE_URL#*://}
  release_authority=${release_authority%%/*}
  case "$release_authority" in
    *@*) fail 4 failed "release URL must not include credentials, a query, or a fragment" ;;
  esac
  case "$BASE_URL" in
    https://*|http://127.0.0.1:*|http://localhost:*) ;;
    *) fail 4 failed "release URL must use HTTPS" ;;
  esac
fi
if [ -n "$CA_BUNDLE" ]; then
  case "$CA_BUNDLE" in
    /*) ;;
    *) usage "--ca-bundle must be an absolute path" ;;
  esac
fi
if [ -n "$PROFILE" ]; then
  case "$PROFILE" in
    /*) ;;
    *) usage "--profile must be an absolute path inside the target user's home" ;;
  esac
fi

BIN_DIR_EXPLICIT=0
[ "${AIDLC_BIN_DIR+x}" = x ] && BIN_DIR_EXPLICIT=1
BIN_DIR=${AIDLC_BIN_DIR:-"$HOME/.local/bin"}
INSTALL_ROOT=${AIDLC_INSTALL_ROOT:-"${XDG_DATA_HOME:-"$HOME/.local/share"}/aidlc"}
case "$BIN_DIR" in
  /*) ;;
  *) fail 4 failed "AIDLC_BIN_DIR must be an absolute path" ;;
esac
case "$INSTALL_ROOT" in
  /*) ;;
  *) fail 4 failed "AIDLC_INSTALL_ROOT must be an absolute path" ;;
esac

resolve_command_path() {
  path=$1
  hops=0
  while [ -L "$path" ] && [ "$hops" -lt 16 ]; do
    link=$(readlink "$path") || break
    case "$link" in
      /*) path=$link ;;
      *) path=$(dirname "$path")/$link ;;
    esac
    directory=$(dirname "$path")
    name=$(basename "$path")
    if resolved_directory=$(CDPATH= cd -P "$directory" 2>/dev/null && pwd -P); then
      path=$resolved_directory/$name
    fi
    hops=$((hops + 1))
  done
  printf '%s\n' "$path"
}

existing_command=$(command -v aidlc 2>/dev/null || true)
if [ "$BIN_DIR_EXPLICIT" -eq 0 ] && [ -n "$existing_command" ] &&
  [ "$existing_command" != "$BIN_DIR/aidlc" ]; then
  existing_manager_path=$(resolve_command_path "$existing_command")
  case "$existing_command $existing_manager_path" in
    */Cellar/*|*/opt/homebrew/*|*/home/linuxbrew/.linuxbrew/*)
      fail 4 failed \
        "existing aidlc is managed by Homebrew at $existing_command" \
        "brew upgrade aidlc, or set AIDLC_BIN_DIR to an explicit user-local destination"
      ;;
    */nix/store/*|*/.nix-profile/*)
      fail 4 failed \
        "existing aidlc is managed by Nix at $existing_command" \
        "upgrade aidlc through Nix, or set AIDLC_BIN_DIR to an explicit user-local destination"
      ;;
  esac
fi

command_target="$BIN_DIR/aidlc"
if [ -e "$command_target" ] || [ -L "$command_target" ]; then
  if [ ! -L "$command_target" ]; then
    fail 4 failed \
      "existing $command_target is not owned by the AI-DLC installer" \
      "choose an empty AIDLC_BIN_DIR or remove the mixed-ownership command"
  fi
  existing_target=$(readlink "$command_target")
  case "$existing_target" in
    "$INSTALL_ROOT"/versions/*/aidlc)
      existing_version=${existing_target#"$INSTALL_ROOT"/versions/}
      existing_version=${existing_version%/aidlc}
      if ! printf '%s\n' "$existing_version" |
        grep -Eq '^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$'; then
        fail 4 failed \
          "existing $command_target has an invalid installer-owned target" \
          "choose an empty AIDLC_BIN_DIR or remove the mixed-ownership command"
      fi
      ;;
    *)
      fail 4 failed \
        "existing $command_target points outside the AI-DLC install root" \
        "use its package manager, or choose an empty AIDLC_BIN_DIR"
      ;;
  esac
fi

case "$(uname -s)" in
  Darwin) OS=darwin ;;
  Linux) OS=linux ;;
  *) usage "unsupported OS: $(uname -s)" ;;
esac
case "$(uname -m)" in
  x86_64|amd64) ARCH=x64 ;;
  arm64|aarch64) ARCH=arm64 ;;
  *) usage "unsupported architecture: $(uname -m)" ;;
esac
TARGET="$OS-$ARCH"
if [ "$OS" = "linux" ]; then
  if ldd --version 2>&1 | grep -qi musl; then
    TARGET="$TARGET-musl"
  fi
fi

umask 077
TMP=$(mktemp -d "${TMPDIR:-/tmp}/aidlc-install.XXXXXX")
trap 'rm -rf "$TMP"' EXIT HUP INT TERM

download() {
  url=$1
  output=$2
  progress_start "$(basename "$output")"
  if command -v curl >/dev/null 2>&1; then
    if [ -n "$CA_BUNDLE" ]; then
      curl -fsSL --cacert "$CA_BUNDLE" "$url" -o "$output" 2>"$TMP/download.err" ||
        fail 3 unavailable "download failed" "check the release URL, proxy, and CA bundle"
    else
      curl -fsSL "$url" -o "$output" 2>"$TMP/download.err" ||
        fail 3 unavailable "download failed" "check the release URL and proxy"
    fi
  elif command -v wget >/dev/null 2>&1; then
    if [ -n "$CA_BUNDLE" ]; then
      wget -q "--ca-certificate=$CA_BUNDLE" "$url" -O "$output" 2>"$TMP/download.err" ||
        fail 3 unavailable "download failed" "check the release URL, proxy, and CA bundle"
    else
      wget -q "$url" -O "$output" 2>"$TMP/download.err" ||
        fail 3 unavailable "download failed" "check the release URL and proxy"
    fi
  else
    fail 1 failed "curl or wget is required"
  fi
  progress_done "$(basename "$output")"
}

sha256_file() {
  if command -v sha256sum >/dev/null 2>&1; then
    sha256sum "$1" | awk '{print $1}'
  elif command -v shasum >/dev/null 2>&1; then
    shasum -a 256 "$1" | awk '{print $1}'
  else
    fail 1 failed "sha256sum or shasum is required"
  fi
}

if [ -n "$FROM" ]; then
  [ -d "$FROM" ] || usage "offline source is not a directory: $FROM"
  for metadata in version.json checksums.txt install.sh; do
    [ -f "$FROM/$metadata" ] || fail 4 failed "offline source is missing $metadata"
    cp "$FROM/$metadata" "$TMP/$metadata"
  done
else
  if [ -n "$VERSION" ]; then
    RELEASE_URL="$BASE_URL/download/v$VERSION"
  else
    RELEASE_URL="$BASE_URL/latest/download"
  fi
  download "$RELEASE_URL/version.json" "$TMP/version.json"
  download "$RELEASE_URL/checksums.txt" "$TMP/checksums.txt"
fi

for metadata in version.json checksums.txt; do
  metadata_bytes=$(wc -c <"$TMP/$metadata" | tr -d ' ')
  [ "$metadata_bytes" -le 1048576 ] ||
    fail 4 failed "$metadata exceeds the 1 MiB metadata limit"
done

expected_manifest=$(sed -n 's/^\([a-f0-9]\{64\}\)  version\.json$/\1/p' "$TMP/checksums.txt")
[ -n "$expected_manifest" ] || fail 4 failed "No checksum for version.json."
actual_manifest=$(sha256_file "$TMP/version.json")
[ "$actual_manifest" = "$expected_manifest" ] || {
  fail 4 failed "Checksum mismatch for version.json."
}

[ -n "$VERSION" ] || VERSION=$(sed -n 's/.*"version":[[:space:]]*"\([0-9][0-9.]*\)".*/\1/p' "$TMP/version.json" | head -n 1)
[ -n "$VERSION" ] || fail 4 failed "version.json has no valid version."
choices=$(awk '
  /"distributions":[[:space:]]*\[/ { section=1; next }
  section && /"assets":[[:space:]]*\[/ { section=0 }
  section && /"name":[[:space:]]*"/ {
    value=$0
    sub(/^.*"name":[[:space:]]*"/, "", value)
    sub(/".*$/, "", value)
    name=value
  }
  section && /"productName":[[:space:]]*"/ {
    value=$0
    sub(/^.*"productName":[[:space:]]*"/, "", value)
    sub(/".*$/, "", value)
    if (name != "") print name "|" value
    name=""
  }
' "$TMP/version.json")
[ -n "$choices" ] || fail 4 failed "version.json contains no harness distributions."
if [ -z "$HARNESSES" ]; then
  echo "Select the harness distribution to install:"
  printf '%s\n' "$choices" | awk -F '|' '{ printf "  %d) %-10s - %s\n", NR, $1, $2 }'
  choice_count=$(printf '%s\n' "$choices" | awk 'END { print NR }')
  printf 'Harness [1-%s]: ' "$choice_count"
  IFS= read -r choice
  case "$choice" in ""|*[!0-9]*) usage "invalid harness selection" ;; esac
  selected=$(printf '%s\n' "$choices" | sed -n "${choice}p" | cut -d '|' -f 1)
  [ -n "$selected" ] || usage "invalid harness selection"
  HARNESSES=" $selected"
else
  for harness in $HARNESSES; do
    printf '%s\n' "$choices" |
      awk -F '|' -v wanted="$harness" '$1 == wanted { found=1 } END { exit(found ? 0 : 1) }' ||
      fail 4 failed "release does not provide harness $harness"
  done
fi
BINARY="aidlc-$TARGET"
ASSETS="$BINARY"
[ -z "$FROM" ] || ASSETS="$ASSETS install.sh"
for harness in $HARNESSES; do ASSETS="$ASSETS aidlc-data-$harness.tgz"; done

for asset in $ASSETS; do
  if [ -n "$FROM" ]; then
    [ -f "$FROM/$asset" ] || fail 4 failed "offline source is missing $asset"
    cp "$FROM/$asset" "$TMP/$asset"
  else
    download "$RELEASE_URL/$asset" "$TMP/$asset"
  fi
  expected=$(sed -n "s/^\\([a-f0-9]\\{64\\}\\)  $asset\$/\\1/p" "$TMP/checksums.txt")
  [ -n "$expected" ] || fail 4 failed "No checksum for $asset."
  actual=$(sha256_file "$TMP/$asset")
  [ "$actual" = "$expected" ] || fail 4 failed "Checksum mismatch for $asset."
done

chmod 755 "$TMP/$BINARY"
args=
for harness in $HARNESSES; do args="$args --harness $harness"; done
# shellcheck disable=SC2086
"$TMP/$BINARY" __delegate lifecycle install-apply --from "$TMP" --version "$VERSION" $args \
  --quiet >"$TMP/apply.out" ||
  fail 4 failed "$(sed -n '1p' "$TMP/apply.out")" "rerun the installer after correcting the reported release error"

profile_message=
if [ -n "$PROFILE" ]; then
  "$TMP/$BINARY" __delegate lifecycle install-profile \
    --profile "$PROFILE" --bin-dir "$BIN_DIR" --quiet >"$TMP/profile.out" ||
    fail 4 failed "$(sed -n '1p' "$TMP/profile.out")"
  profile_message=$(sed -n '1p' "$TMP/profile.out")
fi

path_command=
case ":$PATH:" in
  *":$BIN_DIR:"*) ;;
  *)
    PATH="$BIN_DIR:$PATH" command -v aidlc >/dev/null 2>&1 ||
      fail 4 failed "installed aidlc is not resolvable after applying the PATH update"
    path_command="export PATH=\"$BIN_DIR:\$PATH\""
    ;;
esac

if [ "$MODE" = "json" ]; then
  json_harnesses=
  for harness in $HARNESSES; do
    [ -z "$json_harnesses" ] || json_harnesses="$json_harnesses,"
    json_harnesses="$json_harnesses\"$harness\""
  done
  printf '{"schemaVersion":1,"ok":true,"code":0,"status":"ok","message":"installed AI-DLC %s","data":{"version":"%s","harnesses":[%s],"binDir":"%s","pathCommand":' \
    "$(json_escape "$VERSION")" "$(json_escape "$VERSION")" "$json_harnesses" "$(json_escape "$BIN_DIR")"
  if [ -n "$path_command" ]; then
    printf '"%s"' "$(json_escape "$path_command")"
  else
    printf 'null'
  fi
  printf ',"profile":'
  if [ -n "$PROFILE" ]; then
    printf '"%s"' "$(json_escape "$PROFILE")"
  else
    printf 'null'
  fi
  printf '}}\n'
elif [ "$MODE" = "quiet" ]; then
  if [ -n "$path_command" ]; then
    printf 'installed AI-DLC %s; run %s\n' "$VERSION" "$path_command"
  else
    printf 'installed AI-DLC %s\n' "$VERSION"
  fi
else
  products=
  for harness in $HARNESSES; do
    product=$(awk -v wanted="$harness" '
      /"distributions":[[:space:]]*\[/ { section=1; next }
      section && /"assets":[[:space:]]*\[/ { section=0 }
      section && /"name":[[:space:]]*"/ {
        value=$0
        sub(/^.*"name":[[:space:]]*"/, "", value)
        sub(/".*$/, "", value)
        name=value
      }
      section && /"productName":[[:space:]]*"/ {
        value=$0
        sub(/^.*"productName":[[:space:]]*"/, "", value)
        sub(/".*$/, "", value)
        if (name == wanted) {
          print value
          exit
        }
        name=""
      }
    ' "$TMP/version.json")
    [ -n "$product" ] || product=$harness
    [ -z "$products" ] || products="$products, "
    products="$products$product"
  done
  printf 'PASS installed AI-DLC %s for %s\n' "$VERSION" "$products"
  [ -z "$profile_message" ] || printf '%s\n' "$profile_message"
  if [ -n "$path_command" ]; then
    printf 'Add AI-DLC to PATH for this shell:\n  %s\nThen run: aidlc init\n' "$path_command"
  else
    printf 'Next: aidlc init\n'
  fi
fi
