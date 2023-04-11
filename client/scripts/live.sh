#!/usr/bin/env bash
tsc-watch --onSuccess "node index.js $(printf '%q ' "$@")"
