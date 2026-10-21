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
  for name in $(alias_names); do
    say "gbot wake --check --account $name"
  done
  say "summary: install ref $ref from $repo"
}

if [ "$dry_run" -eq 1 ]; then
  print_plan
  exit 0
fi

if [ -d "$cache/.git" ]; then
  git -C "$cache" remote set-url origin "$repo"
  git -C "$cache" fetch --tags origin
else
  mkdir -p "$(dirname "$cache")"
  git clone "$repo" "$cache"
fi
git -C "$cache" checkout "$ref"
if git -C "$cache" rev-parse --verify --quiet "origin/$ref" >/dev/null; then
  git -C "$cache" merge --ff-only "origin/$ref"
fi

cd "$cache"
npm ci
npm pack
tarball=$(ls -1 grok-bot-cli-*.tgz | head -n 1)
npm install -g "./$tarball"
gbot --version
gbot accounts

import_status=0
if [ -n "$config" ]; then
  set +e
  gbot config import "$config"
  import_status=$?
  set -e
  if [ "$import_status" -eq 2 ]; then
    exit 2
  fi
fi

for name in $(alias_names); do
  set +e
  gbot wake --check --account "$name"
  status=$?
  set -e
  printf 'wake %s exit %s\n' "$name" "$status"
done

if [ "$import_status" -eq 3 ]; then
  say "summary: installed $ref; some imported logins are not signed in on this machine"
  exit 3
fi
say "summary: installed $ref"
exit 0
