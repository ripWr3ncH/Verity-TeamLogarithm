# VERITY — listener service
FROM node:22-alpine AS build
WORKDIR /build
COPY package.json package-lock.json* ./
COPY services/listener/package.json services/listener/
COPY tsconfig.base.json ./
RUN npm install --workspace=@verity/listener --include-workspace-root --no-audit --no-fund
COPY services/listener ./services/listener
RUN npm run build --workspace=@verity/listener

FROM node:22-alpine
WORKDIR /app
ENV NODE_ENV=production
COPY --from=build /build/node_modules ./node_modules
COPY --from=build /build/services/listener/dist ./dist
COPY --from=build /build/services/listener/package.json ./package.json
USER node
CMD ["node", "dist/listener.js"]
