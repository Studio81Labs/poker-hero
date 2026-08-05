#!/usr/bin/env bash
# Resolve the version suffix used by deployment and Sentry release names.
set -euo pipefail

if [ "${GITHUB_REF_TYPE:-}" = "tag" ] && [[ "${GITHUB_REF_NAME:-}" == v* ]]; then
  printf "%s\n" "${GITHUB_REF_NAME#v}"
  exit 0
fi

version="$(git describe --tags --match 'v[0-9]*' --always 2>/dev/null || true)"
if [ -z "$version" ] && [ -n "${GITHUB_SHA:-}" ]; then
  version="${GITHUB_SHA:0:7}"
fi

printf "%s\n" "${version:-0.0.0}" | sed 's/^v//'
