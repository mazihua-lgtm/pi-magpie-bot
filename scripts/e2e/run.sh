#!/usr/bin/env bash
# 一条命令验完：类型、单测、网关、完整链路。
# One command that checks the whole thing: types, unit tests, the gateway, and
# one real conversation through the bot with no chat platform involved.
set -euo pipefail
cd "$(dirname "$0")/../.."

MODEL="${1:-group/free}"
step() { printf '\n\033[1m== %s\033[0m\n' "$*"; }

step "typecheck"
pnpm typecheck

step "unit tests"
pnpm test

step "gateway ($MODEL)"
pnpm smoke "$MODEL"

step "durable runtime ($MODEL)"
pnpm smoke:durable "$MODEL"

step "bot end to end ($MODEL)"
pnpm smoke:bot "$MODEL"

printf '\n\033[32mok\033[0m\n'
