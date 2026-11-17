#!/usr/bin/env bash
# Builds the environment the Android app unpacks on its first run:
#
#   android/app/src/main/assets/bootstrap.payload
#
# Inside are two folders. `sys` is a Linux root the agent runs in - the pieces
# of Ubuntu it actually needs, node, magpie, and this repository with its
# production dependencies. `native` is proot and the libraries that open `sys`
# without root.
#
# Everything is pinned. Downloads land in build/android and are kept, so a
# second run is quick.
#
#   pnpm android:payload        (from the repository root)
set -euo pipefail

ROOT=$(cd "$(dirname "$0")/.." && pwd)
WORK=${WORK:-$ROOT/build/android}
STAGE=$WORK/stage
OUT=$ROOT/android/app/src/main/assets/bootstrap.payload

NODE_VERSION=${NODE_VERSION:-v24.22.3}
UBUNTU=${UBUNTU:-ubuntu-base-24.04.3-base-arm64.tar.gz}
TERMUX=${TERMUX:-https://packages.termux.dev/apt/termux-main}
# Pinned to a commit, never a branch: the free models are a third party and a
# moving head could change what the app runs without this repository changing.
OFM_COMMIT=${OFM_COMMIT:-17c072e0631565d68053b5c03372ea445fd84c8e}

say() { printf '\n== %s\n' "$*"; }

fetch() {
	local url=$1 file=$2
	if [ -s "$WORK/$file" ]; then
		echo "   have $file"
		return
	fi
	echo "   get $url"
	curl -fsSL --retry 3 --connect-timeout 20 --max-time 1800 -o "$WORK/$file.part" "$url"
	mv "$WORK/$file.part" "$WORK/$file"
}

# GitHub's release redirects are the one download that regularly hangs behind a
# proxy. gh gets the same file over the API, so it is asked first when it is there.
fetch_release() {
	local repo=$1 asset=$2 file=$3
	if [ -s "$WORK/$file" ]; then
		echo "   have $file"
		return
	fi
	if command -v gh >/dev/null 2>&1; then
		echo "   get $repo/$asset (gh)"
		if (cd "$WORK" && gh release download --repo "$repo" --pattern "$asset" --clobber) 2>/dev/null; then
			mv "$WORK/$asset" "$WORK/$file"
			return
		fi
	fi
	fetch "https://github.com/$repo/releases/latest/download/$asset" "$file"
}

mkdir -p "$WORK" "$(dirname "$OUT")"

say "downloads"
fetch "https://cdimage.ubuntu.com/ubuntu-base/releases/24.04/release/$UBUNTU" "$UBUNTU"
fetch "https://nodejs.org/dist/$NODE_VERSION/node-$NODE_VERSION-linux-arm64.tar.xz" "node-$NODE_VERSION-linux-arm64.tar.xz"
# The plain Linux CLI build: the Android one wants /system/bin/linker64, which
# is outside the root proot opens, and the desktop one links GTK and WebKitGTK
# for its window, which a phone has neither of nor the room for. This is static.
fetch_release yetone/magpie magpie-cli-linux-arm64 magpie
# Mozilla's roots, as curl serves them: the one file in the root that makes
# HTTPS mean anything to a program that trusts the system store.
fetch "https://curl.se/ca/cacert.pem" "cacert.pem"
# The free-model service: an OpenAI-compatible local gateway with several free
# lanes. The tarball is pinned to a commit so a build is reproducible.
fetch "https://codeload.github.com/Ebony-Vinyl/dsh-our-free-model/tar.gz/$OFM_COMMIT" "ofm.tgz"
fetch "$TERMUX/pool/main/p/proot/proot_5.1.107.102_aarch64.deb" "proot.deb"
fetch "$TERMUX/pool/main/libt/libtalloc/libtalloc_2.5.0_aarch64.deb" "libtalloc.deb"
fetch "$TERMUX/pool/main/liba/libandroid-shmem/libandroid-shmem_0.7_aarch64.deb" "libandroid-shmem.deb"

say "a root, as small as node needs"
rm -rf "$STAGE" "$WORK/ubuntu"
mkdir -p "$STAGE/sys" "$STAGE/native" "$WORK/ubuntu"
tar -xzf "$WORK/$UBUNTU" -C "$WORK/ubuntu"

# The list is short because it was found the hard way: each library below is one
# node asked for by name, and anything else is a hundred megabytes nobody runs.
sys=$STAGE/sys
mkdir -p "$sys/bin" "$sys/lib" "$sys/etc" "$sys/tmp" "$sys/dev" "$sys/proc" "$sys/sys" "$sys/root" "$sys/opt"
cp -L "$WORK/ubuntu/bin/dash" "$sys/bin/sh"
cp -L "$WORK/ubuntu/lib/ld-linux-aarch64.so.1" "$sys/lib/ld-linux-aarch64.so.1" 2>/dev/null ||
	cp -L "$WORK/ubuntu/lib/aarch64-linux-gnu/ld-linux-aarch64.so.1" "$sys/lib/ld-linux-aarch64.so.1"
for lib in libc.so.6 libm.so.6 libdl.so.2 libpthread.so.0 libgcc_s.so.1 libstdc++.so.6; do
	source=$(ls "$WORK/ubuntu/lib/aarch64-linux-gnu/$lib" "$WORK/ubuntu/usr/lib/aarch64-linux-gnu/$lib" 2>/dev/null | head -1 || true)
	if [ -n "$source" ]; then cp -L "$source" "$sys/lib/$lib"; fi
done
# proot binds a real file over this one, and a file has to exist to be bound over.
: >"$sys/etc/resolv.conf"
: >"$sys/etc/hosts"
# Go and anything else that trusts the system store find no certificate
# authority in a root this small - and magpie downloads its plugin runtime over
# HTTPS on first run. node carries its own, which is why only Go noticed.
mkdir -p "$sys/etc/ssl/certs"
cp "$WORK/cacert.pem" "$sys/etc/ssl/certs/ca-certificates.crt"

say "node"
tar -xJf "$WORK/node-$NODE_VERSION-linux-arm64.tar.xz" -C "$WORK"
rm -rf "$sys/opt/node"
mv "$WORK/node-$NODE_VERSION-linux-arm64" "$sys/opt/node"
# 100 MB of headers, npm's own tree and documentation that a phone never reads.
rm -rf "$sys/opt/node/include" "$sys/opt/node/lib/node_modules" "$sys/opt/node/share"
rm -f "$sys/opt/node/bin/npm" "$sys/opt/node/bin/npx" "$sys/opt/node/bin/corepack"
rm -f "$sys/opt/node/CHANGELOG.md" "$sys/opt/node/README.md"

say "magpie"
mkdir -p "$sys/opt/magpie"
cp "$WORK/magpie" "$sys/opt/magpie/magpie"
chmod 755 "$sys/opt/magpie/magpie"

say "the free-model service, slimmed to what actually serves a request"
# The upstream repository is 137M unpacked, but 96M of that is a bundled magpie
# engine (we ship our own), Windows-only engine parts, docs and images. Strip
# those and the standalone gateway is ~27M. Nothing is downloaded or run from
# the network on the phone: the service is part of the APK.
rm -rf "$WORK/ofm" "$sys/opt/ofm"
mkdir -p "$WORK/ofm" "$sys/opt/ofm"
tar -xzf "$WORK/ofm.tgz" -C "$WORK/ofm" --strip-components=1
(cd "$WORK/ofm" && tar -cf - \
	--exclude=.git --exclude=node_modules --exclude=docs --exclude=.github \
	--exclude=vendor/magpie/bin --exclude=src/engine-parts \
	--exclude='*.png' --exclude='*.jpg' --exclude='*.svg' --exclude='*.webp' --exclude='*.gif' \
	--exclude='.trae-html-share-packages' --exclude=client.js \
	.) | tar -xf - -C "$sys/opt/ofm"

say "proot"
rm -rf "$WORK/debs"
python3 - "$WORK" "$WORK/debs" <<'PY'
import lzma, os, sys, tarfile
# A .deb is an ar archive, and macOS ar cannot read these members by name.
work, out = sys.argv[1], sys.argv[2]
for deb in ('proot.deb', 'libtalloc.deb', 'libandroid-shmem.deb'):
    with open(os.path.join(work, deb), 'rb') as archive:
        assert archive.read(8) == b'!<arch>\n', deb
        while True:
            header = archive.read(60)
            if len(header) < 60:
                break
            name = header[:16].decode().strip().rstrip('/')
            size = int(header[48:58].decode().strip() or 0)
            body = archive.read(size)
            if size % 2:
                archive.read(1)
            if name.startswith('data.tar'):
                with tarfile.open(fileobj=__import__('io').BytesIO(lzma.decompress(body))) as data:
                    data.extractall(out)
PY
termux=$WORK/debs/data/data/com.termux/files/usr
cp -L "$termux/bin/proot" "$STAGE/native/proot"
cp -L "$termux/libexec/proot/loader" "$STAGE/native/loader"
cp -L "$termux/lib/libtalloc.so.2" "$STAGE/native/libtalloc.so.2"
cp -L "$termux/lib/libandroid-shmem.so" "$STAGE/native/libandroid-shmem.so"
for name in proot loader libtalloc.so.2 libandroid-shmem.so; do
	[ -f "$STAGE/native/$name" ] || { echo "missing native/$name" >&2; exit 1; }
	chmod 755 "$STAGE/native/$name"
done

say "the repository, with what it needs to run"
rm -rf "$sys/app"
mkdir -p "$sys/app"
# The proxy is the one script the phone runs directly. It gets a fixed path in
# the root so startup does not depend on where a checkout happened to land.
mkdir -p "$sys/opt/ofm-proxy"
cp "$ROOT/scripts/ofm-proxy.mjs" "$sys/opt/ofm-proxy/ofm-proxy.mjs"
# `android` stays behind entirely: it is this app's own source and build output,
# and the asset being written right now lives inside it.
(cd "$ROOT" && tar -cf - --exclude ./node_modules --exclude ./.git --exclude ./build --exclude ./android .) |
	tar -xf - -C "$sys/app"
(cd "$sys/app" && pnpm install --prod --frozen-lockfile --ignore-scripts 2>&1 | tail -3)

# Type declarations, source maps and test folders are for a compiler, and no
# compiler runs on the phone.
find "$sys/app/node_modules" -name '*.map' -delete
find "$sys/app/node_modules" \( -name '*.d.ts' -o -name '*.d.mts' -o -name '*.d.cts' \) -delete
find "$sys/app/node_modules" -type d \( -name test -o -name tests -o -name docs -o -name .github \) -prune -exec rm -rf {} +
find "$sys/app/node_modules" -name '*.md' -not -iname 'LICENSE*' -not -iname 'NOTICE*' -delete

# Binaries for machines this app does not run on. pnpm resolves esbuild's
# optional dependencies for the host doing the install, so a build made on an
# Apple Mac carries two Mach-O binaries (~20 MB) that an arm64 Linux phone can
# never execute. The Linux binary is still required by name, so nothing breaks.
find "$sys/app/node_modules/.pnpm" -maxdepth 1 -type d \
	\( -name '@esbuild+darwin-*' -o -name '@esbuild+win32-*' -o -name '@esbuild+linux-x64*' -o -name '@esbuild+linux-ia32*' \) \
	-exec rm -rf {} +

say "tarball"
tar -C "$STAGE" -czf "$OUT" sys native
ls -lh "$OUT"
printf 'unpacked: %s\n' "$(du -sh "$STAGE" | cut -f1)"
printf '  sys:    %s\n' "$(du -sh "$sys" | cut -f1)"
printf '  native: %s\n' "$(du -sh "$STAGE/native" | cut -f1)"
