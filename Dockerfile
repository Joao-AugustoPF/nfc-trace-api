FROM node:24.18.0-bookworm-slim AS build
WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY tsconfig*.json ./
COPY src ./src
COPY scripts/build-metadata.cjs scripts/source-identity.cjs ./scripts/
ARG BUILD_REVISION
ENV BUILD_REVISION=$BUILD_REVISION
RUN npm run build && npm prune --omit=dev

FROM node:24.18.0-bookworm-slim
ENV NODE_ENV=production
WORKDIR /app
COPY --from=build --chown=node:node /app/node_modules ./node_modules
COPY --from=build --chown=node:node /app/dist ./dist
COPY --from=build --chown=node:node /app/package.json ./package.json
USER node
EXPOSE 3000
CMD ["node", "dist/bootstrap/main.js"]
