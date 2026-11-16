# The bot only; magpie runs as its own service (see compose.yml).
FROM node:24-bookworm-slim

WORKDIR /app
# A container keeps UTC unless told otherwise, and the agent reads its own clock.
ENV DATA_DIR=/data \
	WEB_HOST=0.0.0.0 \
	WEB_PORT=8787 \
	TZ=Asia/Shanghai

RUN corepack enable

# Dependencies first: they change far less often than the code.
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.json ./
COPY packages ./packages
COPY apps ./apps
RUN pnpm install --frozen-lockfile

# Set only after installing: the app runs through tsx, which is a dev dependency,
# and a production install would leave it out.
ENV NODE_ENV=production

# Not root: this process talks to strangers on a chat platform.
RUN mkdir -p /data && chown node:node /data
USER node

VOLUME /data
EXPOSE 8787
CMD ["node_modules/.bin/tsx", "apps/bot/src/main.ts"]
