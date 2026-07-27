# Container image for the ffmpeg-render-pro MCP server.
#
# The server speaks MCP over stdio, so run the container attached and talk
# JSON-RPC on stdin/stdout:
#
#   docker run -i --rm ffmpeg-render-pro
#
# To render into a host directory, mount it and pass paths under the mount:
#
#   docker run -i --rm -v "$PWD:/work" -w /work ffmpeg-render-pro
#
# ffmpeg and ffprobe are installed because every render, probe, concat, and
# encoder-detection path shells out to them.

FROM node:20-slim

RUN apt-get update \
    && apt-get install -y --no-install-recommends ffmpeg \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Dependencies first so the layer survives source edits. --ignore-scripts
# because nothing in the tree needs a build step and neither runtime
# dependency has an install hook.
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts

# Runtime files only. src/ carries the server, the core modules, and the
# dashboard template; examples/basic-worker.js is what get_worker_template
# reads; bin/ is the CLI the same install exposes.
COPY src ./src
COPY bin ./bin
COPY examples ./examples
COPY llms.txt README.md LICENSE ./

ENV NODE_ENV=production

# GPU probe results cache to disk. Point them at a writable path so the
# app directory can stay read-only.
ENV FFMPEG_RENDER_PRO_CACHE_DIR=/tmp/ffmpeg-render-pro

USER node

ENTRYPOINT ["node", "/app/src/mcp-server.mjs"]
