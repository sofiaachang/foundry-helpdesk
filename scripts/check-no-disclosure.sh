#!/usr/bin/env bash
# Structural proof that no tool route can reach Foundry unverified.
#
# Two properties hold the "no read before verification" claim up regardless of
# the prompt (plan U7, KTD5, KTD8):
#   1. foundry/* is imported only from server.ts (the composition root) and from
#      foundry/* itself. Routes receive the adapter as a typed option; they never
#      import it. Type-only imports (`import type ...`) are erased at compile
#      time and cannot reach Foundry, so they are allowed anywhere. Test files
#      (__tests__/, *.test.ts) are not shipped and may import the fake adapter.
#   2. Every method on the adapter interface except findUserByPhone (needed
#      before verification) takes `session: VerifiedSession` as its first
#      parameter, and only the tier gate can mint that value.
#
# Usage: scripts/check-no-disclosure.sh [root]   (root defaults to service/src)
# Exit 0 on pass; non-zero with the offending path:line printed otherwise.
# Tested against planted violations in service/scripts/__tests__.
set -uo pipefail

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
root="${1:-$script_dir/../service/src}"

if [[ ! -d "$root" ]]; then
  echo "FAIL: root directory not found: $root"
  exit 2
fi
root="$(cd "$root" && pwd)"
adapter="$root/foundry/adapter.ts"
status=0

echo "== foundry/ imports outside server.ts and foundry/ =="
# Runtime imports of a foundry/ path: `from "…foundry/…"`, `import("…foundry/…")`,
# `require("…foundry/…")`. Lines beginning with `import type` are erased by tsc.
import_hits=$(
  grep -rnE --include='*.ts' \
    -e '(from|import\(|require\()[[:space:]]*['"'"'"][^'"'"'"]*foundry/' \
    "$root" 2>/dev/null \
  | grep -vE "^$root/server\.ts:" \
  | grep -vE "^$root/foundry/" \
  | grep -vE "^$root/(.*/)?__tests__/" \
  | grep -vE '^[^:]*\.test\.ts:' \
  | grep -vE '^[^:]+:[0-9]+:[[:space:]]*import[[:space:]]+type[[:space:]]' \
  | grep -vE '^[^:]+:[0-9]+:[[:space:]]*(//|\*)' \
  || true
)
if [[ -n "$import_hits" ]]; then
  echo "$import_hits"
  echo "FAIL: foundry/ imported outside server.ts and foundry/"
  status=1
else
  echo "  none"
fi

echo
echo "== adapter methods require session: VerifiedSession first =="
if [[ ! -f "$adapter" ]]; then
  echo "FAIL: adapter not found at $adapter"
  status=1
else
  # A method signature is an indented identifier followed by "(". Control-flow
  # keywords and constructors are not methods. Multi-line signatures are read
  # up to the "(" only, so the first parameter must be on the same line or the
  # next non-blank one.
  sig_hits=$(
    awk -v file="$adapter" '
      function check(name, rest, lineno) {
        if (name == "findUserByPhone") return
        if (rest ~ /^[[:space:]]*session[[:space:]]*:[[:space:]]*VerifiedSession([[:space:]]*[,)]|$)/) return
        printf "%s:%d: %s( missing session: VerifiedSession as first parameter\n", file, lineno, name
      }
      pending != "" {
        if ($0 ~ /^[[:space:]]*$/) next
        check(pending, $0, pendingLine); pending = ""
        next
      }
      /^[[:space:]]*(\/\/|\*|\/\*)/ { next }
      match($0, /^[[:space:]]*(async[[:space:]]+)?[A-Za-z_][A-Za-z0-9_]*[[:space:]]*\(/) {
        head = substr($0, RSTART, RLENGTH)
        rest = substr($0, RSTART + RLENGTH)
        gsub(/^[[:space:]]*(async[[:space:]]+)?/, "", head)
        sub(/[[:space:]]*\($/, "", head)
        if (head ~ /^(if|for|while|switch|catch|return|constructor|function|typeof|new|await)$/) next
        if (rest ~ /^[[:space:]]*$/) { pending = head; pendingLine = NR; next }
        check(head, rest, NR)
      }
    ' "$adapter"
  )
  if [[ -n "$sig_hits" ]]; then
    echo "$sig_hits"
    echo "FAIL: adapter method without a VerifiedSession first parameter"
    status=1
  else
    echo "  every method after findUserByPhone takes session: VerifiedSession"
  fi
fi

echo
if [[ $status -eq 0 ]]; then
  echo "PASS: no route can reach Foundry without a gated session"
else
  echo "FAIL: disclosure boundary violated"
fi
exit $status
