FROM oven/bun:1.4.4 AS bun
FROM node:24.22.1-bookworm-slim
RUN apt-get update && apt-get install -y --no-install-recommends git ca-certificates inotify-tools \
    && rm -rf /var/lib/apt/lists/*
COPY --from=bun /usr/local/bin/bun /usr/local/bin/bun
WORKDIR /app
# Next rewrites next-env.d.ts in dev mode. Keep generated files in the container.
COPY package.json bun.lock bunfig.toml next.config.mjs postcss.config.mjs \
    tsconfig.json next-env.d.ts source.config.ts /app/site/
