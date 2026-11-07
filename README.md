# NEXUS

ABION Industries' operations platform. Full spec: `NEXUS-PRD.md` (keep alongside this repo — it is the source of truth for architecture, IA, and phase sequencing).

Build state: see `SESSION_LOG.md`.

## Structure
- `apps/web` — React + TS + Vite frontend
- `apps/api` — Node + TS + Fastify API
- `packages/shared` — types shared by both
- `database/` — PostgreSQL schema + migrations

## Dev
```
npm install
docker compose up -d           # local Postgres, no account needed
npm run migrate -w apps/api    # apply database/migrations
npm run dev:api                # localhost:3001
npm run dev:web                # localhost:5173
```

Database hosting (Supabase Cloud vs. self-hosted, and how to move
between them later): `DEPLOYMENT.md`.
