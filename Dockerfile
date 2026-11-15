# The bot only; magpie runs as its own service (see deploy/docker-compose.yml).
FROM node:24-bookworm-slim

WORKDIR /app
ENV DATA_DIR=/data \
	WEB_HOST=0.0.0.0 \
	WEB_PORT=8787

RUN corepack enable

# Dependencies first: they change far less often than the code.
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.json ./
COPY packages ./packages
COPY apps ./apps
RUN pnpm install --frozen-lockfile

# Set only after installing: the app runs through tsx, which is a dev dependency,
# and a production install would leave it out.
ENV NODE_ENV=production

VOLUME /data
EXPOSE 8787
CMD ["pnpm", "exec", "tsx", "apps/bot/src/main.ts"]
