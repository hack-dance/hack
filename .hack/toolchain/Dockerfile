FROM debian:13-slim@sha256:d7e12182ce18b85b93007c1dedf31f2d29e01ccf3182cc4017c709b6259bc132
RUN apt-get update && apt-get install -y --no-install-recommends \
    ca-certificates curl git build-essential pkg-config libssl-dev unzip xz-utils util-linux procps python3 \
    && rm -rf /var/lib/apt/lists/*
ARG TARGETARCH
RUN case "$TARGETARCH" in \
      arm64) arch=arm64; sha=1b46a14314c18f9bbce4bf6f88cc1fb3b31be8dd2b23327a851555f4e144fc61 ;; \
      amd64) arch=x64; sha=f917e52216924ef0a8b4eca3f7004dfcff3b94665716ac5685fd53006a491eee ;; \
      *) exit 1 ;; \
    esac && curl -fsSL "https://github.com/jdx/mise/releases/download/v2026.9.10/mise-v2026.9.10-linux-$arch" -o /usr/local/bin/mise \
    && echo "$sha  /usr/local/bin/mise" | sha256sum -c - && chmod +x /usr/local/bin/mise
ENV MISE_DATA_DIR=/opt/mise MISE_CONFIG_DIR=/opt/mise-config MISE_CACHE_DIR=/tmp/mise-cache \
    MISE_YES=1 MISE_TRUSTED_CONFIG_PATHS=/app MISE_RUSTUP_HOME=/opt/rustup \
    RUSTUP_HOME=/opt/rustup CARGO_HOME=/opt/cargo \
    TLA2TOOLS_JAR=/opt/tla/tla2tools-1.7.4.jar HUSKY=0
WORKDIR /app
COPY mise.toml /app/mise.toml
RUN mise install && mise exec -- bun --version && mise exec -- cargo --version
RUN mkdir -p /opt/tla && curl -fsSL https://github.com/tlaplus/tlaplus/releases/download/v1.7.4/tla2tools.jar -o "$TLA2TOOLS_JAR" \
    && echo "936a262061c914694dfd669a543be24573c45d5aa0ff20a8b96b23d01e050e88  $TLA2TOOLS_JAR" | sha256sum -c -
COPY .hack/toolchain/run.sh /usr/local/bin/hack-toolchain
ENTRYPOINT ["mise", "exec", "--", "sh", "/usr/local/bin/hack-toolchain"]
CMD ["models"]
