# VERITY — api service
FROM node:22-alpine AS build
WORKDIR /build
COPY package.json package-lock.json* ./
COPY services/api/package.json services/api/
COPY tsconfig.base.json ./
RUN npm install --workspace=@verity/api --include-workspace-root --no-audit --no-fund
COPY services/api ./services/api
RUN npm run build --workspace=@verity/api

FROM node:22-alpine
WORKDIR /app
ENV NODE_ENV=production
COPY --from=build /build/node_modules ./node_modules
COPY --from=build /build/services/api/dist ./dist
COPY --from=build /build/services/api/package.json ./package.json
USER node
CMD ["node", "dist/server.js"]
