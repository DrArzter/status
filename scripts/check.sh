#!/usr/bin/env bash

# The whole local ladder, as one command. Nothing here needs credentials and
# nothing here can create anything: the bundle rung is a dry run.
#
#   scripts/check.sh          run everything
#   scripts/check.sh static   typecheck
#   scripts/check.sh tests    the suite, in workerd against a real D1
#   scripts/check.sh bundle   the production Worker, built but not deployed
#
# CI runs the same three by name, one job each, so a shard that fails locally
# fails in the same words there. The database id is a placeholder: the bundle
# is never deployed from here, and Wrangler only wants the field to be shaped
# like one.

set -Eeuo pipefail

REPOSITORY_ROOT="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
cd -- "${REPOSITORY_ROOT}"
mode="${1:-full}"

PLACEHOLDER_DATABASE_ID="00000000-0000-4000-8000-000000000000"

failures=()
step() {
  local name="$1"
  shift
  printf '==> %s\n' "${name}"
  if "$@"; then
    printf 'ok  %s\n' "${name}"
  else
    printf 'FAIL %s\n' "${name}"
    failures+=("${name}")
  fi
}

check_types() {
  npm run --silent typecheck
}

check_tests() {
  npm test --silent
}

# Built the way the deploy builds it, and thrown away. It catches a binding
# named in the configuration and missing from the code, which neither the types
# nor the suite can see.
check_bundle() {
  local config=".wrangler.check.jsonc"
  local out
  out="$(mktemp -d)"
  D1_DATABASE_ID="${PLACEHOLDER_DATABASE_ID}" node scripts/render-wrangler-config.mjs "${config}"
  local status=0
  npx wrangler deploy --dry-run --config "${config}" --outdir "${out}" || status=1
  rm -rf -- "${config}" "${out}"
  return "${status}"
}

run_static() { step "typecheck" check_types; }
run_tests() { step "suite" check_tests; }
run_bundle() { step "production Worker bundle" check_bundle; }

case "${mode}" in
  full)
    run_static
    run_tests
    run_bundle
    ;;
  static) run_static ;;
  tests) run_tests ;;
  bundle) run_bundle ;;
  *)
    printf 'usage: scripts/check.sh [full|static|tests|bundle]\n' >&2
    exit 2
    ;;
esac

if (( ${#failures[@]} > 0 )); then
  printf '\nfailed: %s\n' "${failures[*]}"
  exit 1
fi
printf '\nall checks passed\n'
