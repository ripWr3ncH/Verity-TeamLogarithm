# ==========================================================================
#  VERITY — the portal.
#
#  Built as a container for one reason: on the day, `./scripts/up.sh` has to
#  leave a working http://localhost:3000 behind. A portal that only starts
#  when somebody remembers to run `npm run dev` in a second terminal is a
#  portal that will be missing when a judge walks up.
#
#  Note what this container does NOT do: it never talks to the API itself.
#  Every fetch in web/lib/api.ts runs in the judge's BROWSER, against the
#  published http://localhost:4000. So this image needs no network access to
#  verity_net, no crypto material, and no identity of its own — which is also
#  why it is safe for it to be the only component reachable without one.
# ==========================================================================

FROM node:22-alpine AS deps
WORKDIR /app
COPY web/package.json ./
RUN npm install --no-audit --no-fund

FROM node:22-alpine AS build
WORKDIR /app
ENV NEXT_TELEMETRY_DISABLED=1
COPY --from=deps /app/node_modules ./node_modules
COPY web/ ./
RUN npm run build

# `output: 'standalone'` in next.config.mjs emits a server that carries only the
# modules it actually imports — the runtime image needs no node_modules at all.
FROM node:22-alpine AS runtime
WORKDIR /app
ENV NODE_ENV=production NEXT_TELEMETRY_DISABLED=1 PORT=3000 HOSTNAME=0.0.0.0
COPY --from=build /app/.next/standalone ./
COPY --from=build /app/.next/static ./.next/static
EXPOSE 3000
CMD ["node", "server.js"]
