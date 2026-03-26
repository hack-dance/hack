# syntax=docker/dockerfile:1.7

FROM oven/bun:1.3.9 AS hack-build

WORKDIR /src
COPY package.json bun.lock bunfig.toml tsconfig.json index.ts ./
# Keep the install context aligned with root workspaces so frozen lockfile
# validation sees the same workspace graph as the checked-in repository.
COPY apps ./apps
COPY packages ./packages
COPY services ./services
COPY src ./src
RUN bun install --frozen-lockfile
RUN bun build index.ts --compile --outfile /out/hack

FROM docker:27-cli AS docker-cli
FROM tailscale/tailscale:stable AS tailscale-bin

FROM debian:bookworm-slim

ARG HACK_VERSION=dev
ARG BUILD_DATE=unknown
ARG VCS_REF=unknown

LABEL org.opencontainers.image.title="hack-node-runtime"
LABEL org.opencontainers.image.description="Containerized hack node runtime for remote multi-node execution"
LABEL org.opencontainers.image.version="${HACK_VERSION}"
LABEL org.opencontainers.image.created="${BUILD_DATE}"
LABEL org.opencontainers.image.revision="${VCS_REF}"
LABEL org.opencontainers.image.source="https://github.com/hack-dance/hack-cli"

RUN apt-get update \
  && apt-get install -y --no-install-recommends \
    bash \
    ca-certificates \
    git \
    openssh-client \
  && rm -rf /var/lib/apt/lists/*

RUN mkdir -p /usr/local/libexec/docker/cli-plugins

COPY --from=docker-cli /usr/local/bin/docker /usr/local/bin/docker
COPY --from=docker-cli /usr/local/libexec/docker/cli-plugins/docker-compose /usr/local/libexec/docker/cli-plugins/docker-compose
COPY --from=tailscale-bin /usr/local/bin/tailscale /usr/local/bin/tailscale
COPY --from=tailscale-bin /usr/local/bin/tailscaled /usr/local/bin/tailscaled

COPY --from=hack-build /out/hack /usr/local/bin/hack
COPY docker/node-runtime/entrypoint.sh /usr/local/bin/hack-node-entrypoint

RUN chmod +x /usr/local/bin/hack /usr/local/bin/hack-node-entrypoint \
  /usr/local/bin/tailscale /usr/local/bin/tailscaled \
  && ln -sf /usr/local/libexec/docker/cli-plugins/docker-compose /usr/local/bin/docker-compose \
  && mkdir -p /var/lib/hack /workspace

ENV HOME=/var/lib/hack
ENV HACK_NODE_WORKDIR=/workspace
ENV HACK_NODE_PROJECT_DIR=/workspace/node-project
ENV HACK_NODE_PROJECT_NAME=hack-node
ENV HACK_NODE_AUTO_INIT=1
ENV HACK_NODE_GATEWAY_ENABLE=1
ENV HACK_NODE_GATEWAY_BIND=0.0.0.0
ENV HACK_NODE_GATEWAY_ALLOW_WRITES=1

WORKDIR /workspace
VOLUME ["/var/lib/hack", "/workspace"]
EXPOSE 7788

HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 CMD hack daemon status --json >/dev/null || exit 1

ENTRYPOINT ["/usr/local/bin/hack-node-entrypoint"]
