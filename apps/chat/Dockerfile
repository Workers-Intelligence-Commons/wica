# Image of the chat application for Compose. The build context is the repository root,
# submodules included: the chat depends on the workspace packages and on the design system in
# `vendor/wic-design-system`, compiled by the root `postinstall`.

FROM oven/bun:1.4.4 AS build
WORKDIR /app
COPY . .
RUN bun install --frozen-lockfile && cd apps/chat && bun run build

FROM node:22-slim
ENV NODE_ENV=production
WORKDIR /app
COPY --from=build /app /app
WORKDIR /app/apps/chat
USER node
EXPOSE 3000
CMD ["node", "node/start.mjs"]
