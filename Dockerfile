# The bot only; magpie runs as its own service (see compose.yml).
FROM node:24-bookworm-slim

WORKDIR /app
# A container keeps UTC unless told otherwise, and the agent reads its own clock.
# HOME is on the volume too: magpie keeps its keys, plugins and routing groups
# under it, and a container that forgets them on every restart is no gateway.
ENV DATA_DIR=/data \
	HOME=/data \
	WEB_HOST=0.0.0.0 \
	WEB_PORT=8787 \
	TZ=Asia/Shanghai

# magpie is a Go program with its own TLS stack: without a CA bundle it cannot
# reach GitHub to fetch the plugin runtime and the free-model plugin.
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates \
	&& rm -rf /var/lib/apt/lists/*

RUN corepack enable

# Dependencies first: they change far less often than the code.
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.json ./
COPY packages ./packages
COPY apps ./apps
# Production only: node runs the TypeScript sources itself, so the compiler, the
# test runner and tsx are not needed to serve anyone.
RUN pnpm install --prod --frozen-lockfile

ENV NODE_ENV=production

# Not root: this process talks to strangers on a chat platform.
RUN mkdir -p /data && chown node:node /data
USER node

VOLUME /data
EXPOSE 8787
CMD ["node", "apps/bot/src/main.ts"]
