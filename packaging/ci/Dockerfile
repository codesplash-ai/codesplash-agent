FROM oven/bun:1.3.14
USER root
RUN apt-get update && apt-get install -y --no-install-recommends bubblewrap socat ripgrep git npm ca-certificates tini && rm -rf /var/lib/apt/lists/*
WORKDIR /workspace
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile --backend=copyfile
COPY src ./src
COPY scripts ./scripts
COPY tests ./tests
COPY docs/server.md docs/integrations.md docs/observability-and-tools.md docs/distribution.md docs/termux.md ./docs/
COPY examples ./examples
COPY integrations ./integrations
COPY packaging ./packaging
COPY extensions ./extensions
COPY tsconfig.json tsconfig.build.json biome.json LICENSE README.md CHANGELOG.md THIRD_PARTY_NOTICES.md ./
RUN chown -R bun:bun /workspace
USER bun
RUN git init -q
ENV CODESPLASH_DIAGNOSTICS_DISABLED=1
ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["bun", "run", "check"]
