#!/usr/bin/env bash
# 一条命令装好这个助理 / One command to install this assistant.
#
#   ./install.sh              install and start the web chat
#   ./install.sh --telegram   install, then ask for a Telegram bot token
#   ./install.sh --no-magpie  keep the magpie I already run
#
# What it does: checks Node, installs the dependencies, downloads magpie (the
# gateway that reaches the models), adds the free-model plugin, signs in to the
# anonymous pool, creates the `free` routing group, and writes .env. Nothing
# asks for an API key: the free pool needs no account. Bring your own provider
# later in `magpie web`.
set -euo pipefail

cd "$(dirname "$0")"

say() { printf '\033[1m→\033[0m %s\n' "$*"; }
warn() { printf '\033[33m!\033[0m %s\n' "$*"; }
die() { printf '\033[31m✗\033[0m %s\n' "$*" >&2; exit 1; }

# A download that gives up on a dead connection instead of hanging on it: three
# tries, each resuming where the last one stopped, and a connection under 10 KB/s
# for 30 seconds counts as dead.
fetch() {
	local url="$1" out="$2" try=1 rc
	while :; do
		rc=0
		curl -fSL --connect-timeout 15 --speed-time 30 --speed-limit 10240 -C - "$url" -o "$out" || rc=$?
		[ "$rc" -eq 0 ] && return 0
		# 33: the server says there is nothing left to send, which means the file
		# is already whole — the checksum decides whether that is true.
		[ "$rc" -eq 33 ] && return 0
		[ "$try" -ge 3 ] && return 1
		try=$((try + 1))
		warn "download stalled; retrying ($try/3)"
		sleep 2
	done
}

# Coreutils says sha256sum, macOS says shasum; either one checking the line is fine.
checksum_ok() {
	if command -v sha256sum >/dev/null 2>&1; then
		sha256sum -c -
	else
		shasum -a 256 -c -
	fi
}

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
	die "Node.js 24 or newer is required (the built-in SQLite needs it): https://nodejs.org"
fi
NODE_MAJOR="$(node -p 'process.versions.node.split(".")[0]')"
if [ "$NODE_MAJOR" -lt 24 ]; then
	die "Node.js $(node -v) is too old; 24 or newer is required: https://nodejs.org"
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
	fetch "$URL" "$TMP/$FILE" || die "could not download magpie from $URL"
	if fetch "$SUMS" "$TMP/SHA256SUMS" >/dev/null 2>&1; then
		if (cd "$TMP" && grep " $FILE\$" SHA256SUMS | checksum_ok >/dev/null 2>&1); then
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

# --- 2. the free pool, then magpie -------------------------------------------
FREE_GROUP_ID="free"
FREE_PLUGIN_URL="https://github.com/mu-zi-lee/magpie-our-free-model"

# magpie inherits this machine's proxy settings; a proxy that is set and dead
# breaks its downloads, so each command is tried again with none.
run_magpie() {
	"$MAGPIE_BIN" "$@" 2>/dev/null && return 0
	env -u HTTP_PROXY -u HTTPS_PROXY -u ALL_PROXY "$MAGPIE_BIN" "$@" 2>/dev/null
}

gateway_up() { curl -fsS --max-time 2 http://127.0.0.1:3425/v1/models >/dev/null 2>&1; }

if [ "$MANAGE_MAGPIE" = 1 ] && [ -n "$MAGPIE_BIN" ]; then
	mkdir -p "$HOME/.local/state/magpie-bot"
	LOG="$HOME/.local/state/magpie-bot/magpie.log"

	# Everything here happens with no gateway listening: the free pool's sign-in
	# asks a running magpie for a management page it has no key for and is
	# refused, so it only works while nothing is up.
	if ! gateway_up; then
		say "adding the free-model plugin"
		run_magpie plugin add "$FREE_PLUGIN_URL" || warn "could not add the free-model plugin; free models will not appear"

		say "signing in to the free pool"
		# Its one question has two answers; the first is the one that hands the
		# gateway its models with no browser involved. stdin is fed twice on
		# purpose: a second try needs its own answer.
		#
		# What it says when it fails is the only thing that tells the two very
		# different failures apart — an address whose quota is used up, and a
		# network that cannot fetch the pool's channel pack — so it is kept and
		# repeated rather than swallowed.
		SIGNIN="$(mktemp)"
		if ! printf '1\n' | "$MAGPIE_BIN" plugin login our-free-model >"$SIGNIN" 2>&1; then
			printf '1\n' | env -u HTTP_PROXY -u HTTPS_PROXY -u ALL_PROXY "$MAGPIE_BIN" plugin login our-free-model >"$SIGNIN" 2>&1 ||
				warn "the sign-in did not finish: $(grep -v '^[[:space:]]*$' "$SIGNIN" | tail -n 1 | sed 's/^> *//')"
		fi
		rm -f "$SIGNIN"

		say "starting magpie (log: $LOG)"
		(env -u HTTP_PROXY -u HTTPS_PROXY -u ALL_PROXY nohup "$MAGPIE_BIN" serve >"$LOG" 2>&1 &)
		for _ in $(seq 1 60); do
			gateway_up && break
			sleep 1
		done
	fi

	if gateway_up; then
		run_magpie group add "$FREE_GROUP_ID" 'models=our-free-model/*' routing=smart ||
			warn "could not create the '$FREE_GROUP_ID' routing group"
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
