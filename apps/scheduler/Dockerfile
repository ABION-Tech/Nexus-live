# Build/run @nexus/scheduler standalone. Built from the repo root
# (this monorepo uses npm workspaces — packages/shared etc. need to be
# reachable at build time), e.g.:
#   docker build -f apps/scheduler/Dockerfile -t nexus-scheduler .
#   docker run --env-file apps/scheduler/.env nexus-scheduler
FROM node:22-alpine AS build
WORKDIR /repo
COPY package.json package-lock.json tsconfig.base.json ./
COPY packages/shared/package.json packages/shared/
COPY apps/scheduler/package.json apps/scheduler/
RUN npm ci
COPY packages/shared packages/shared
COPY apps/scheduler apps/scheduler
RUN npm run build -w packages/shared && npm run build -w apps/scheduler

FROM node:22-alpine
WORKDIR /repo
ENV NODE_ENV=production
COPY --from=build /repo/node_modules node_modules
COPY --from=build /repo/packages/shared packages/shared
COPY --from=build /repo/apps/scheduler apps/scheduler
WORKDIR /repo/apps/scheduler
CMD ["node", "dist/index.js"]
