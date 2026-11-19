#!/usr/bin/env bash
# Checks that a PUBLIC API does not answer staff/admin routes. Run against the public API's address (never production).
#   BASE_URL=http://localhost:4000 scripts/loadtest/exposure-check.sh
# Today (single shared API) these paths ARE answered (401/403/400), so the check FAILS: that is the baseline Option C must change.
# After the split, every path must return 404 from the public API.
: "${BASE_URL:?set BASE_URL}"
case "$BASE_URL" in *railway*|*up.app*) echo "refusing: looks deployed"; exit 2;; esac
fail=0
for p in /api/admin/auth/login /api/admin/auth/session /api/admin/schools /api/admin/trips /api/admin/staff /api/admin/audit; do
  code=$(curl -s -o /dev/null -w '%{http_code}' -X POST "$BASE_URL$p" -H 'Content-Type: application/json' -d '{}')
  [ "$code" = "404" ] && echo "ok    $p -> 404" || { echo "EXPOSED $p -> $code"; fail=1; }
done
exit $fail
