# Build context is the repo root (the server depends on the contracts workspace).
FROM oven/bun:1.4.2 AS build
WORKDIR /repo
COPY package.json bun.lock ./
COPY contracts/package.json contracts/
COPY server/package.json server/
RUN bun install --frozen-lockfile
COPY contracts contracts
COPY server server
ENV NEXT_TELEMETRY_DISABLED=1 NEXT_OUTPUT=standalone
RUN cd server && bun run build

# One-shot job that applies database migrations before the app starts.
FROM build AS migrate
WORKDIR /repo/server
CMD ["bun", "src/db/migrate.ts"]

FROM node:22-slim AS app
WORKDIR /app
ENV NODE_ENV=production NEXT_TELEMETRY_DISABLED=1 HOSTNAME=0.0.0.0 PORT=3000
COPY --from=build /repo/server/.next/standalone ./
COPY --from=build /repo/server/.next/static ./server/.next/static
USER node
EXPOSE 3000
CMD ["node", "server/server.js"]
