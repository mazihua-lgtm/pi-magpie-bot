#!/usr/bin/env bash
# 一条命令装好这个助理 / One command to install this assistant.
#
#   ./install.sh              install and start the web chat
#   ./install.sh --telegram   install, then ask for a Telegram bot token
#   ./install.sh --no-magpie  keep the magpie I already run
#
# What it does: checks Node, installs the dependencies, downloads magpie (the
# gateway that reaches the models), adds the free-model plugin, creates the
# `free` routing group, and writes .env. Nothing asks for an API key: the free
# pool needs no account. Bring your own provider later in `magpie web`.
set -euo pipefail

cd "$(dirname "$0")"

say() { printf '\033[1m→\033[0m %s\n' "$*"; }
warn() { printf '\033[33m!\033[0m %s\n' "$*"; }
die() { printf '\033[31m✗\033[0m %s\n' "$*" >&2; exit 1; }

TELEGRAM=0
MANAGE_MAGPIE=1
for arg in "$@"; do
	case "$arg" in
		--telegram) TELEGRAM=1 ;;
		--no-magpie) MANAGE_MAGPIE=0 ;;
		-h | --help) sed -n '2,12p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
		*) die "unknown option: $arg" ;;
	esac
done

# --- 1. Node -----------------------------------------------------------------
if ! command -v node >/dev/null 2>&1; then
	die "Node.js 22 or newer is required: https://nodejs.org (LTS is fine)"
fi
NODE_MAJOR="$(node -p 'process.versions.node.split(".")[0]')"
if [ "$NODE_MAJOR" -lt 22 ]; then
	die "Node.js $(node -v) is too old; 22 or newer is required: https://nodejs.org"
fi
say "node $(node -v)"

if ! command -v pnpm >/dev/null 2>&1; then
	command -v corepack >/dev/null 2>&1 || die "pnpm is missing and corepack is not available; install pnpm: https://pnpm.io/installation"
	corepack enable >/dev/null 2>&1 || true
	corepack prepare pnpm@10.15.0 --activate >/dev/null 2>&1 || true
fi
command -v pnpm >/dev/null 2>&1 || die "pnpm still not on PATH; install it: https://pnpm.io/installation"
say "pnpm $(pnpm -v)"

# --- 2. magpie ---------------------------------------------------------------
MAGPIE_BIN="${MAGPIE_BIN:-$(command -v magpie || true)}"
if [ "$MANAGE_MAGPIE" = 1 ] && [ -z "$MAGPIE_BIN" ] && [ ! -x "$HOME/.local/bin/magpie" ]; then
	OS="$(uname -s | tr '[:upper:]' '[:lower:]')"
	case "$(uname -m)" in
		x86_64 | amd64) ARCH=amd64 ;;
		arm64 | aarch64) ARCH=arm64 ;;
		*) die "unsupported CPU: $(uname -m)" ;;
	esac
	case "$OS" in
		darwin | linux) ;;
		*) die "unsupported system: $OS (Windows: use the desktop app from https://usemagpie.ai, or WSL)" ;;
	esac

	FILE="magpie-cli-$OS-$ARCH"
	URL="https://github.com/yetone/magpie/releases/latest/download/$FILE"
	SUMS="https://github.com/yetone/magpie/releases/latest/download/SHA256SUMS"
	say "downloading magpie ($FILE)"
	mkdir -p "$HOME/.local/bin"
	TMP="$(mktemp -d)"
	curl -fsSL "$URL" -o "$TMP/$FILE" || die "could not download magpie from $URL"
	if curl -fsSL "$SUMS" -o "$TMP/SHA256SUMS" 2>/dev/null; then
		if (cd "$TMP" && grep " $FILE\$" SHA256SUMS | shasum -a 256 -c - >/dev/null 2>&1); then
			say "checksum ok"
		else
			die "checksum mismatch for $FILE; not installing it"
		fi
	else
		warn "no SHA256SUMS published; installing without a checksum"
	fi
	mv "$TMP/$FILE" "$HOME/.local/bin/magpie"
	chmod 755 "$HOME/.local/bin/magpie"
	rm -rf "$TMP"
	MAGPIE_BIN="$HOME/.local/bin/magpie"
	case ":$PATH:" in
		*":$HOME/.local/bin:"*) ;;
		*) warn "$HOME/.local/bin is not on PATH; add it so \`magpie\` works in a terminal" ;;
	esac
fi

FREE_GROUP_ID="free"
if [ "$MANAGE_MAGPIE" = 1 ] && [ -n "$MAGPIE_BIN" ]; then
	mkdir -p "$HOME/.local/state/magpie-bot"
	LOG="$HOME/.local/state/magpie-bot/magpie.log"
	if ! curl -fsS --max-time 2 http://127.0.0.1:3425/v1/models >/dev/null 2>&1; then
		say "starting magpie (log: $LOG)"
		# The gateway must not inherit a proxy it may not have; a stale HTTPS_PROXY
		# is what breaks plugin downloads.
		(env -u HTTP_PROXY -u HTTPS_PROXY -u ALL_PROXY nohup "$MAGPIE_BIN" serve >"$LOG" 2>&1 &)
		for _ in $(seq 1 60); do
			curl -fsS --max-time 2 http://127.0.0.1:3425/v1/models >/dev/null 2>&1 && break
			sleep 1
		done
	fi
	if curl -fsS --max-time 3 http://127.0.0.1:3425/v1/models >/dev/null 2>&1; then
		say "gateway is up on 127.0.0.1:3425"
		if ! env -u HTTP_PROXY -u HTTPS_PROXY -u ALL_PROXY "$MAGPIE_BIN" providers 2>/dev/null | grep -q "our-free-model"; then
			PLUGIN_DIR="$HOME/.local/share/pi-magpie-bot/magpie-our-free-model"
			if [ ! -d "$PLUGIN_DIR" ]; then
				say "adding the free-model plugin"
				git clone --depth 1 https://github.com/mu-zi-lee/magpie-our-free-model "$PLUGIN_DIR" >/dev/null 2>&1 ||
					warn "could not clone the free-model plugin; free models will not appear"
			fi
			[ -d "$PLUGIN_DIR" ] && env -u HTTP_PROXY -u HTTPS_PROXY -u ALL_PROXY "$MAGPIE_BIN" plugin add "$PLUGIN_DIR" >/dev/null 2>&1 || true
		fi
		env -u HTTP_PROXY -u HTTPS_PROXY -u ALL_PROXY "$MAGPIE_BIN" group add "$FREE_GROUP_ID" 'models=our-free-model/*' routing=smart >/dev/null 2>&1 || true
		say "routing group '$FREE_GROUP_ID' ready (model id: group/$FREE_GROUP_ID)"
	else
		warn "magpie did not answer on 127.0.0.1:3425; see $LOG"
	fi
fi

# --- 3. dependencies ---------------------------------------------------------
say "installing dependencies"
pnpm install --prod=false >/dev/null 2>&1 || pnpm install

# --- 4. .env -----------------------------------------------------------------
if [ -f .env ]; then
	say ".env already exists, leaving it alone"
else
	cp .env.example .env
	if [ "$TELEGRAM" = 1 ]; then
		printf 'Telegram bot token from @BotFather (leave empty to skip): '
		read -r TOKEN || TOKEN=""
		if [ -n "${TOKEN:-}" ]; then
			printf 'TELEGRAM_BOT_TOKEN=%s\n' "$TOKEN" | cat - .env >.env.tmp && mv .env.tmp .env
			say "Telegram token saved to .env"
		else
			warn "no token; the web chat still works"
		fi
	fi
fi

say "installed"
cat <<'DONE'

  启动 / Start:     pnpm start
  网页聊天 / Chat:  http://127.0.0.1:8787
  换模型 / Models:  magpie web       (open Routing to change the free group)
  配置 / Config:    .env             (token, port, password, model id)

DONE
