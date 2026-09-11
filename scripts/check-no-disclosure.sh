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
echo "== adapter members require session: VerifiedSession first =="
if [[ ! -f "$adapter" ]]; then
  echo "FAIL: adapter not found at $adapter"
  status=1
else
  # Rather than pattern-match individual signature shapes (plain methods,
  # `readonly`/`async` prefixes, generic `<T>` parameter lists, and
  # property-style arrow members like `name: (...) => Promise<...>` all look
  # different lexically), this walks the body of `interface FoundryAdapter`
  # brace-depth aware, joins each member's possibly-multi-line text into one
  # logical statement (split on `;` at the interface's own nesting depth so a
  # `;` inside a nested object type like `input: { title: string }` doesn't
  # end the member early), and applies one allowlist rule: any member whose
  # text contains "Promise<" must also contain "session: VerifiedSession"
  # unless it names findUserByPhone.
  sig_hits=$(
    awk -v file="$adapter" '
      function flush(lineno,    m, name, hasPromise, hasSession, hasFindUser) {
        m = buf
        buf = ""
        gsub(/^[ \t\n]+|[ \t\n]+$/, "", m)
        if (m == "") return
        hasFindUser = (m ~ /findUserByPhone/)
        hasPromise = (m ~ /Promise[[:space:]]*</)
        hasSession = (m ~ /session[[:space:]]*:[[:space:]]*VerifiedSession/)
        if (!hasFindUser && hasPromise && !hasSession) {
          name = m
          gsub(/^(readonly|async)[[:space:]]+/, "", name)
          match(name, /^[A-Za-z_][A-Za-z0-9_]*/)
          name = substr(name, RSTART, RLENGTH)
          printf "%s:%d: %s( missing session: VerifiedSession as first parameter\n", file, bufLine, name
        }
      }
      function process(s, lineno,    i, c) {
        for (i = 1; i <= length(s); i++) {
          c = substr(s, i, 1)
          if (buf == "") bufLine = lineno
          if (c == "{") {
            depth++
            buf = buf c
          } else if (c == "}") {
            if (depth == 0) {
              flush(lineno)
              inInterface = 0
              return
            }
            depth--
            buf = buf c
          } else if (c == ";" && depth == 0) {
            buf = buf c
            flush(lineno)
          } else {
            buf = buf c
          }
        }
        if (buf != "") buf = buf "\n"
      }
      BEGIN { inInterface = 0; depth = 0; buf = ""; bufLine = 0 }
      {
        if (!inInterface) {
          if ($0 ~ /(^|[^A-Za-z0-9_])interface[[:space:]]+FoundryAdapter([[:space:]]|\{|$)/) {
            inInterface = 1
            depth = 0
            buf = ""
            idx = index($0, "{")
            if (idx > 0) process(substr($0, idx + 1), NR)
          }
          next
        }
        process($0, NR)
      }
    ' "$adapter"
  )
  if [[ -n "$sig_hits" ]]; then
    echo "$sig_hits"
    echo "FAIL: adapter member without a VerifiedSession first parameter"
    status=1
  else
    echo "  every member after findUserByPhone takes session: VerifiedSession"
  fi
fi

echo
echo "== no VerifiedSession minted via cast outside lib/tiers.ts =="
# The tier gate in lib/tiers.ts is the only code allowed to mint a
# VerifiedSession. A cast (`as VerifiedSession`, `satisfies VerifiedSession`,
# or the `<VerifiedSession>expr` prefix form) anywhere else manufactures one
# without going through the gate.
cast_hits=$(
  grep -rnE --include='*.ts' \
    -e '\bas[[:space:]]+VerifiedSession\b' \
    -e '\bsatisfies[[:space:]]+VerifiedSession\b' \
    -e '(^|[^A-Za-z0-9_>])<VerifiedSession>' \
    "$root" 2>/dev/null \
  | grep -vE "^$root/lib/tiers\.ts:" \
  | grep -vE "^$root/(.*/)?__tests__/" \
  | grep -vE '^[^:]*\.test\.ts:' \
  || true
)
if [[ -n "$cast_hits" ]]; then
  echo "$cast_hits"
  echo "FAIL: VerifiedSession minted via cast outside lib/tiers.ts"
  status=1
else
  echo "  none"
fi

echo
if [[ $status -eq 0 ]]; then
  echo "PASS: no route can reach Foundry without a gated session"
else
  echo "FAIL: disclosure boundary violated"
fi
exit $status
