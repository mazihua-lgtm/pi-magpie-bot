#!/usr/bin/env bash
# 一条命令从零装好 / Install from nothing with one command:
#
#   curl -fsSL https://raw.githubusercontent.com/mazihua-lgtm/pi-magpie-bot/main/get.sh | bash
#
# No git, Node or pnpm needed first. It puts everything under ~/.pi-magpie-bot,
# adds the free models (see install.sh), starts the assistant, makes it start
# again at login, and opens the chat. Run it again any time to update.
#
# Options (after `bash -s --`): --no-autostart, --no-open, --no-magpie,
# --manage-existing-magpie.
# Environment: PI_MAGPIE_BOT_HOME (default ~/.pi-magpie-bot),
# PI_MAGPIE_BOT_SRC (a tarball URL or file to install from instead of GitHub main).
set -euo pipefail

say() { printf '\033[1m→\033[0m %s\n' "$*"; }
warn() { printf '\033[33m!\033[0m %s\n' "$*"; }
die() { printf '\033[31m✗\033[0m %s\n' "$*" >&2; exit 1; }

ROOT="${PI_MAGPIE_BOT_HOME:-$HOME/.pi-magpie-bot}"
SRC="${PI_MAGPIE_BOT_SRC:-https://github.com/mazihua-lgtm/pi-magpie-bot/archive/refs/heads/main.tar.gz}"
NODE_MAJOR_WANTED=24
PNPM_VERSION=10.15.0

AUTOSTART=1
OPEN=1
INSTALL_ARGS=()
for arg in "$@"; do
	case "$arg" in
		--no-autostart) AUTOSTART=0 ;;
		--no-open) OPEN=0 ;;
		--no-magpie | --manage-existing-magpie) INSTALL_ARGS+=("$arg") ;;
		-h | --help) sed -n '2,13p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
		*) die "unknown option: $arg" ;;
	esac
done

command -v curl >/dev/null 2>&1 || die "curl is required"
command -v tar >/dev/null 2>&1 || die "tar is required"

OS="$(uname -s | tr '[:upper:]' '[:lower:]')"
case "$OS" in
	darwin | linux) ;;
	*) die "this installer is for macOS and Linux (Windows: use WSL, or Docker Desktop with 'docker compose up')" ;;
esac
case "$(uname -m)" in
	x86_64 | amd64) ARCH=x64 ;;
	arm64 | aarch64) ARCH=arm64 ;;
	*) die "unsupported CPU: $(uname -m)" ;;
esac

# A download that gives up on a dead connection, and on a dead proxy tries once
# more without one (a proxy that is set and gone is common).
fetch() {
	local url="$1" out="$2"
	curl -fSL --connect-timeout 15 --speed-time 30 --speed-limit 10240 --retry 2 "$url" -o "$out" 2>/dev/null && return 0
	env -u HTTP_PROXY -u HTTPS_PROXY -u ALL_PROXY -u http_proxy -u https_proxy -u all_proxy \
		curl -fSL --connect-timeout 15 --speed-time 30 --speed-limit 10240 --retry 2 "$url" -o "$out"
}

checksum_ok() {
	if command -v sha256sum >/dev/null 2>&1; then sha256sum -c -; else shasum -a 256 -c -; fi
}

mkdir -p "$ROOT"
chmod 700 "$ROOT"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

# --- 1. Node: the one on this machine if it is new enough, else our own ----------
NODE_DIR=""
if command -v node >/dev/null 2>&1 && [ "$(node -p 'process.versions.node.split(".")[0]')" -ge "$NODE_MAJOR_WANTED" ]; then
	NODE_DIR="$(dirname "$(command -v node)")"
	say "using node $(node -v) from $NODE_DIR"
elif [ -x "$ROOT/node/bin/node" ] && [ "$("$ROOT/node/bin/node" -p 'process.versions.node.split(".")[0]')" -ge "$NODE_MAJOR_WANTED" ]; then
	NODE_DIR="$ROOT/node/bin"
	say "using our node $("$NODE_DIR/node" -v)"
else
	say "downloading Node.js $NODE_MAJOR_WANTED (kept inside $ROOT, nothing system-wide)"
	BASE="https://nodejs.org/dist/latest-v$NODE_MAJOR_WANTED.x"
	fetch "$BASE/SHASUMS256.txt" "$TMP/SHASUMS256.txt" || die "could not reach nodejs.org"
	FILE="$(grep -oE "node-v[0-9.]+-$OS-$ARCH\.tar\.gz" "$TMP/SHASUMS256.txt" | head -n 1)"
	[ -n "$FILE" ] || die "no Node.js build for $OS-$ARCH"
	fetch "$BASE/$FILE" "$TMP/$FILE" || die "could not download $FILE"
	(cd "$TMP" && grep " $FILE\$" SHASUMS256.txt | checksum_ok >/dev/null 2>&1) || die "checksum mismatch for $FILE; not installing it"
	say "checksum ok"
	rm -rf "$ROOT/node"
	mkdir -p "$ROOT/node"
	tar -xzf "$TMP/$FILE" -C "$ROOT/node" --strip-components=1
	NODE_DIR="$ROOT/node/bin"
fi
export PATH="$NODE_DIR:$PATH"

# --- 2. pnpm ----------------------------------------------------------------
TOOLS_BIN=""
if ! command -v pnpm >/dev/null 2>&1; then
	say "installing pnpm $PNPM_VERSION"
	command -v npm >/dev/null 2>&1 || die "npm is missing next to node"
	npm install --prefix "$ROOT/tools" "pnpm@$PNPM_VERSION" --no-audit --no-fund --loglevel=error >/dev/null ||
		env -u HTTP_PROXY -u HTTPS_PROXY -u ALL_PROXY -u http_proxy -u https_proxy -u all_proxy \
			npm install --prefix "$ROOT/tools" "pnpm@$PNPM_VERSION" --no-audit --no-fund --loglevel=error >/dev/null ||
		die "could not install pnpm"
	TOOLS_BIN="$ROOT/tools/node_modules/.bin"
	export PATH="$TOOLS_BIN:$PATH"
fi
PNPM_DIR="$(dirname "$(command -v pnpm)")"

# --- 3. the code ----------------------------------------------------------------
say "fetching the assistant"
case "$SRC" in
	http://* | https://*) fetch "$SRC" "$TMP/src.tar.gz" || die "could not download $SRC" ;;
	*) cp "$SRC" "$TMP/src.tar.gz" ;;
esac
mkdir -p "$TMP/new"
tar -xzf "$TMP/src.tar.gz" -C "$TMP/new" --strip-components=1
[ -f "$TMP/new/package.json" ] || die "that archive does not look like pi-magpie-bot"
# An update keeps the settings the user wrote.
[ -f "$ROOT/app/.env" ] && cp -p "$ROOT/app/.env" "$TMP/new/.env"
rm -rf "$ROOT/app.old"
[ -d "$ROOT/app" ] && mv "$ROOT/app" "$ROOT/app.old"
mv "$TMP/new" "$ROOT/app"
rm -rf "$ROOT/app.old"

# --- 4. install (dependencies, free models, .env) ------------------------------------
say "setting up (the first time takes a few minutes)"
(cd "$ROOT/app" && DATA_DIR="$ROOT" GET_SH=1 ./install.sh ${INSTALL_ARGS[@]+"${INSTALL_ARGS[@]}"})

# --- 5. launcher and manager --------------------------------------------------
cat >"$ROOT/run.sh" <<RUN
#!/usr/bin/env bash
# Starts the assistant. Written by get.sh; the service manager runs this.
export PATH="$NODE_DIR:$PNPM_DIR:/usr/local/bin:/usr/bin:/bin:\$HOME/.local/bin"
export DATA_DIR="$ROOT"
cd "$ROOT/app"
exec pnpm start
RUN
chmod 755 "$ROOT/run.sh"

cp "$ROOT/app/scripts/pi-magpie-bot" "$ROOT/pi-magpie-bot"
chmod 755 "$ROOT/pi-magpie-bot"
mkdir -p "$HOME/.local/bin"
ln -sf "$ROOT/pi-magpie-bot" "$HOME/.local/bin/pi-magpie-bot"
case ":$PATH:" in
	*":$HOME/.local/bin:"*) ;;
	*) warn "$HOME/.local/bin is not on PATH; use $ROOT/pi-magpie-bot instead of the short command below" ;;
esac

# --- 6. start it, and keep it started -----------------------------------------------
MANAGER="$ROOT/pi-magpie-bot"
if [ "$AUTOSTART" = 1 ]; then
	"$MANAGER" enable
else
	"$MANAGER" start
fi

URL="$("$MANAGER" url)"
say "waiting for the chat to come up"
UP=0
for _ in $(seq 1 90); do
	if curl -fsS --noproxy '*' --max-time 2 "$URL" >/dev/null 2>&1; then UP=1; break; fi
	sleep 1
done

echo
if [ "$UP" = 1 ]; then
	say "ready: $URL"
	if [ "$OPEN" = 1 ]; then
		if [ "$OS" = darwin ]; then
			open "$URL" >/dev/null 2>&1 || true
		elif command -v xdg-open >/dev/null 2>&1 && [ -n "${DISPLAY:-}${WAYLAND_DISPLAY:-}" ]; then
			xdg-open "$URL" >/dev/null 2>&1 || true
		fi
	fi
else
	warn "it did not answer yet; look at the log with: pi-magpie-bot logs"
fi
cat <<DONE

  聊天网页 / Chat:   $URL
  看日志 / Logs:     pi-magpie-bot logs
  停止 / 重启:       pi-magpie-bot stop   |   pi-magpie-bot restart
  更新 / Update:     pi-magpie-bot update
  卸载 / Uninstall:  pi-magpie-bot uninstall
  接 Telegram 等:    编辑 $ROOT/app/.env 后 pi-magpie-bot restart

DONE
