# syntax=docker/dockerfile:1.7

FROM rust:1.97.1-slim-bookworm AS supervisor-build
WORKDIR /src
COPY packages/lifecycle-supervisor ./packages/lifecycle-supervisor
RUN cargo +1.97.1 build --locked --release --jobs 2 --manifest-path packages/lifecycle-supervisor/Cargo.toml --target-dir /build

FROM oven/bun:1.4.4 AS hack-build

WORKDIR /src
COPY package.json bun.lock bunfig.toml tsconfig.json index.ts ./
COPY apps ./apps
COPY packages ./packages
COPY src ./src
RUN bun install --frozen-lockfile
RUN bun build index.ts --compile --outfile /out/hack

FROM oven/bun:1.4.4

ARG HACK_VERSION=dev
ARG BUILD_DATE=unknown
ARG VCS_REF=unknown

LABEL org.opencontainers.image.title="hack-slim-runtime"
LABEL org.opencontainers.image.description="Portable hack slim runtime for managed containers and remote agent environments"
LABEL org.opencontainers.image.version="${HACK_VERSION}"
LABEL org.opencontainers.image.created="${BUILD_DATE}"
LABEL org.opencontainers.image.revision="${VCS_REF}"
LABEL org.opencontainers.image.source="https://github.com/hack-dance/hack"

RUN apt-get update \
  && apt-get install -y --no-install-recommends \
    bash \
    ca-certificates \
    curl \
    git \
    openssh-client \
  && rm -rf /var/lib/apt/lists/*

COPY --from=hack-build /out/hack /usr/local/bin/hack
COPY --from=supervisor-build /build/release/hack-lifecycle-supervisor /usr/local/bin/hack-lifecycle-supervisor

RUN chmod 755 /usr/local/bin/hack /usr/local/bin/hack-lifecycle-supervisor \
  && mkdir -p /var/lib/hack /workspace

ENV HOME=/var/lib/hack
ENV HACK_EXECUTION_MODE=codex
ENV HACK_DAEMON_DISABLE_DOCKER_EVENTS=1

WORKDIR /workspace
VOLUME ["/var/lib/hack", "/workspace"]

CMD ["hack", "--help"]
