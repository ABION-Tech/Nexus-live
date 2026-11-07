# Build/run @nexus/api for production (Railway). Built from the repo root
# because npm workspaces need packages/shared at build time:
#   docker build -f apps/api/Dockerfile -t nexus-api .
#
# Node 22 (not 20) is required: @nexus/shared's package.json points
# "main" at src/index.ts, and only Node >= 22.18 can import a .ts file
# at runtime (built-in type stripping). On Node 20 the API crashes on
# its first value import from @nexus/shared.
FROM node:22-alpine AS build
WORKDIR /repo
COPY package.json package-lock.json tsconfig.base.json ./
COPY packages/shared/package.json packages/shared/
COPY apps/api/package.json apps/api/
RUN npm ci --workspace apps/api --include-workspace-root
COPY packages/shared packages/shared
COPY apps/api apps/api
RUN npm run build -w packages/shared && npm run build -w apps/api

FROM node:22-alpine
WORKDIR /repo
ENV NODE_ENV=production
COPY --from=build /repo/package.json ./
COPY --from=build /repo/node_modules node_modules
COPY --from=build /repo/packages/shared packages/shared
COPY --from=build /repo/apps/api/package.json apps/api/
COPY --from=build /repo/apps/api/dist apps/api/dist
# migrate.js resolves ../../../../database/migrations from dist/scripts
COPY database/migrations database/migrations
WORKDIR /repo/apps/api
EXPOSE 3001
CMD ["node", "dist/server.js"]
