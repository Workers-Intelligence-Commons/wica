# Image de l'application du chat pour le Compose. Le contexte de construction est la racine du
# dépôt, sous-modules compris : le chat dépend des paquets de l'espace de travail et du design
# system dans `vendor/wic-design-system`, compilé par le `postinstall` de la racine.

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
