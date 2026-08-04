# syntax=docker/dockerfile:1.7

FROM oven/bun:1.2-slim AS builder
WORKDIR /openkey

RUN printf '{"private":true,"workspaces":["packages/*"]}\n' > package.json
COPY --from=openkey-src tsconfig.json tsconfig.json
COPY --from=openkey-src packages/core/package.json packages/core/package.json
COPY --from=openkey-src packages/sdk/package.json packages/sdk/package.json
RUN bun install --ignore-scripts
COPY --from=openkey-src packages/core packages/core
COPY --from=openkey-src packages/sdk packages/sdk
RUN cd packages/core && bun run build
RUN cd packages/sdk && bun run build

RUN mkdir -p /built \
    && printf '%s\n' \
      '{"name":"@openkey/sdk","version":"0.9.0","main":"./dist/index.js","module":"./dist/index.mjs","types":"./dist/index.d.ts","exports":{".":{"types":"./dist/index.d.ts","import":"./dist/index.mjs","require":"./dist/index.js"}},"files":["dist"]}' \
      > /built/package.json \
    && cp -R packages/sdk/dist /built/dist

FROM debian:bookworm-slim AS exporter
COPY --from=builder /built /built
CMD ["sh", "-c", "cp -R /built/. /out/"]
