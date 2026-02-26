FROM oven/bun:1

WORKDIR /app

# Install service dependencies first for better layer caching.
COPY services/auth-broker/package.json ./package.json
RUN bun install --frozen-lockfile || bun install

# Copy runtime source only.
COPY services/auth-broker/src ./src
COPY services/auth-broker/tsconfig.json ./tsconfig.json

ENV NODE_ENV=production
EXPOSE 8080

CMD ["bun", "src/index.ts"]
