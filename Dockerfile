FROM oven/bun:1.3.0
WORKDIR /app
COPY package.json package-lock.json ./
COPY packages/ ./packages/
COPY scripts/ ./scripts/
RUN bun install --frozen-lockfile --ignore-scripts && bun scripts/patch-photon.mjs
ENV MSGZLE_ROLE=relay MSGZLE_HOST=0.0.0.0 MSGZLE_DATA_DIR=/data
RUN mkdir /data && chown bun:bun /data
USER bun
EXPOSE 19791
CMD ["bun", "packages/server/src/server.ts"]
