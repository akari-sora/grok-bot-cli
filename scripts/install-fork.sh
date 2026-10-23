#!/bin/sh
# Install this fork from GitLab without npm or a git+https link.
# The pack step runs `npm ci` first because `npm pack` runs agent-bundle prepack,
# which fills dist/ from the committed artifact/. No token is read or printed.
set -eu

repo="https://gitlab.com/aa22396584/grok-bot-cli.git"
ref="main"
config=""
dry_run=0
allow_root=0

while [ $# -gt 0 ]; do
  case "$1" in
    --dry-run)
      dry_run=1
      shift
      ;;
    --allow-root)
      allow_root=1
      shift
      ;;
    --config)
      if [ $# -lt 2 ]; then
        echo "install-fork.sh: --config needs a file" >&2
        exit 2
      fi
      config=$2
      shift 2
      ;;
    --)
      shift
      if [ $# -gt 0 ]; then
        ref=$1
        shift
      fi
      break
      ;;
    -*)
      echo "install-fork.sh: unknown option $1" >&2
      exit 2
      ;;
    *)
      ref=$1
      shift
      ;;
  esac
done

case "$ref" in
  -*)
    echo "install-fork.sh: invalid ref" >&2
    exit 2
    ;;
esac
printf '%s' "$ref" | grep -Eq '^[A-Za-z0-9._/-]+$' || {
  echo "install-fork.sh: invalid ref" >&2
  exit 2
}

if [ -n "$config" ]; then
  config_dir=$(CDPATH= cd -- "$(dirname "$config")" && pwd) || exit $?
  config="$config_dir/$(basename "$config")"
  if [ ! -f "$config" ] || [ ! -r "$config" ]; then
    echo "install-fork.sh: config is not a readable file: $config" >&2
    exit 2
  fi
fi

if [ "$(id -u)" -eq 0 ] && [ "$allow_root" -ne 1 ]; then
  echo "install-fork.sh: refusing to run as root; pass --allow-root" >&2
  exit 2
fi

cache="${XDG_CACHE_HOME:-$HOME/.cache}/grok-bot-cli/src"

say() {
  printf '%s\n' "$*"
}

alias_names() {
  if [ -z "$config" ]; then
    return 0
  fi
  node -e '
    const fs = require("node:fs");
    const doc = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
    const aliases = doc && doc.aliases && typeof doc.aliases === "object" ? Object.keys(doc.aliases) : [];
    for (const name of aliases) process.stdout.write(name + "\n");
  ' "$config"
}

alias_email() {
  node -e '
    const fs = require("node:fs");
    const doc = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
    const alias = doc && doc.aliases ? doc.aliases[process.argv[2]] : null;
    const email = alias && typeof alias.email === "string" ? alias.email : "";
    process.stdout.write(email);
  ' "$config" "$1" 2>/dev/null || true
}

import_reported_missing() {
  name=$1
  if [ "$import_status" -ne 3 ]; then
    return 1
  fi
  email=$(alias_email "$name")
  if printf '%s\n' "$import_log" | grep -F -x -q "sign in to ${name} in the Grok Bot app"; then
    return 0
  fi
  if [ -n "$email" ] && printf '%s\n' "$import_log" | grep -F -x -q "sign in to ${email} in the Grok Bot app"; then
    return 0
  fi
  return 1
}

print_plan() {
  say "git clone or fetch $repo into $cache"
  say "git checkout $ref"
  say "npm ci"
  say "npm pack"
  say "npm install -g ./grok-bot-cli-*.tgz"
  say "gbot --version"
  say "gbot accounts"
  if [ -n "$config" ]; then
    say "gbot config import $config"
  fi
  names=$(alias_names) || exit $?
  for name in $names; do
    say "gbot wake --check --account $name"
  done
  say "summary: install ref $ref from $repo"
}

if [ "$dry_run" -eq 1 ]; then
  print_plan
  exit 0
fi

if [ -d "$cache/.git" ]; then
  git -C "$cache" remote set-url origin "$repo" || exit $?
  git -C "$cache" fetch --tags origin || exit $?
else
  mkdir -p "$(dirname "$cache")" || exit $?
  git clone "$repo" "$cache" || exit $?
fi

dirty=$(git -C "$cache" status --porcelain) || exit $?
if [ -n "$dirty" ]; then
  echo "install-fork.sh: cache is dirty; refusing to overwrite $cache" >&2
  exit 2
fi

sha=""
if git -C "$cache" rev-parse --verify --quiet "refs/remotes/origin/$ref^{commit}" >/dev/null; then
  sha=$(git -C "$cache" rev-parse --verify "refs/remotes/origin/$ref^{commit}") || exit $?
elif git -C "$cache" rev-parse --verify --quiet "refs/tags/$ref^{commit}" >/dev/null; then
  sha=$(git -C "$cache" rev-parse --verify "refs/tags/$ref^{commit}") || exit $?
else
  git -C "$cache" fetch origin -- "$ref" || exit $?
  sha=$(git -C "$cache" rev-parse --verify "FETCH_HEAD^{commit}") || exit $?
fi
printf '%s' "$sha" | grep -Eq '^[0-9a-f]{40}([0-9a-f]{24})?$' || {
  echo "install-fork.sh: resolved commit is not a git sha" >&2
  exit 2
}
git -C "$cache" checkout --detach "$sha" || exit $?
say "resolved commit $sha"

cd "$cache"
npm ci || exit $?
pack_dir=$(mktemp -d "${TMPDIR:-/tmp}/grok-bot-cli-pack.XXXXXX") || exit $?
trap 'rm -rf -- "$pack_dir"' EXIT HUP INT TERM
pack_out=$(npm pack --pack-destination "$pack_dir") || exit 1
tarball=$(printf '%s\n' "$pack_out" | awk 'NF { line=$0 } END { print line }')
tarball=$(basename "$tarball")
if [ -z "$tarball" ] || [ ! -f "$pack_dir/$tarball" ]; then
  echo "install-fork.sh: npm pack did not create $tarball" >&2
  exit 1
fi
npm install -g "$pack_dir/$tarball" || exit $?
gbot --version || exit $?
gbot accounts || true

import_status=0
import_log=""
if [ -n "$config" ]; then
  set +e
  import_log=$(gbot config import "$config" 2>&1)
  import_status=$?
  set -e
  if [ -n "$import_log" ]; then
    printf '%s\n' "$import_log"
  fi
  if [ "$import_status" -ne 0 ] && [ "$import_status" -ne 3 ]; then
    exit "$import_status"
  fi
fi

names=$(alias_names) || exit $?
for name in $names; do
  if import_reported_missing "$name"; then
    continue
  fi
  set +e
  gbot wake --check --account "$name"
  status=$?
  set -e
  if [ "$status" -ne 0 ]; then
    printf 'wake %s exit %s\n' "$name" "$status" >&2
    exit "$status"
  fi
done

if [ "$import_status" -eq 3 ]; then
  say "summary: installed $ref; some imported logins are not signed in on this machine"
  exit 3
fi
say "summary: installed $ref"
exit 0
