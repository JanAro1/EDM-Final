# MediData — Enterprise Data Management (EDM) for Healthcare

MediData is a full healthcare **Enterprise Data Management** platform: synthetic source
systems (EMR, LIS, billing, insurance, legacy CSV, HL7 v2), staging, ETL, data quality,
master data management (patient golden record), a dimensional warehouse, governance,
analytics/KPIs, a deterministic ML risk model, REST + FHIR APIs, and a Next.js UI.

> **New here?** Read [docs/HOW_IT_WORKS.md](docs/HOW_IT_WORKS.md) for the end-to-end data
> lifecycle, schema map, business rules, API contract, and a 10-minute demo walkthrough.
>
> **Presentation scope:** [docs/SCOPE.md](docs/SCOPE.md) — the Healthcare / Labs flow:
> EMR, LIS, billing and insurance sources → ETL/ELT + APIs → HIPAA/ISO 15189 governance →
> Patient 360 and compliance views.

> **IMPORTANT — all data is SYNTHETIC.** Every patient, provider, claim, and lab result is
> machine-generated fake data. No real PHI is stored or processed. The demo targets the
> **Neon free tier, which has no BAA** — a Business Associate Agreement is required before
> real PHI may touch a cloud database. Never point this project at a real clinical system.

## What is implemented

| Layer            | Highlights                                                                                                                                    |
| ---------------- | --------------------------------------------------------------------------------------------------------------------------------------------- |
| Ingestion        | 5 fixtures connectors → `staging` with checksums + idempotent upserts; HL7 ADT/ORU over HTTP                                                  |
| ETL              | TypeScript transforms, SQL assets, warehouse loader (dims/facts), run ledger in `gov.PipelineRun`                                             |
| Data quality     | SQL-assertion rule engine, scorecard, freshness SLAs, deliberate seeded defects                                                               |
| MDM              | Weighted fuzzy matching, blocking, auto-merge ≥ 0.97, human review 0.85–0.97, survivorship EMR > LIS > BILLING > INSURANCE > LEGACY            |
| Warehouse        | Star schema (`warehouse.DimPatient`, `DimProvider`, `DimDate`, `FactEncounter`, `FactLabResult`, `FactClaim`) + materialized views              |
| Analytics        | Duplicate-rate, lab turnaround and billing-lag improvement KPIs                                                                                |
| ML               | Fixed-weight logistic risk model with per-patient DQ gate and top-factor explanations                                                          |
| Governance       | Catalog, glossary, lineage, audit trail, RBAC (CASL), MDM review queue                                                                         |
| APIs             | Express REST, OpenAPI 3 document, FHIR `Patient`/`Observation`, SSE events, HMAC webhooks, outbox                                              |
| Web              | Next.js 15 App Router: dashboard, patients/360, labs, billing, insurance, analytics, governance/MDM, admin                                    |
| Ops              | One-command setup, prefixed multi-process dev runner, one-shot pipeline, unit + API smoke suites                                               |

## Architecture

```
fixtures/ (EMR, LIS, billing, insurance, legacy, HL7)
        │  extractors (checksum + idempotency)
        ▼
    staging.*  ──transform──▶  app.* (OLTP)  ──MDM──▶  gov.MdmMaster / MdmMergeCandidate
        │                          │
        │                          ├──DQ──▶ gov.DqRule / DqResult (scorecards)
        │                          ├──ML──▶ risk scores + explanations (DQ-gated)
        │                          └──ETL─▶ warehouse.* (dims/facts + materialized views)
        ▼
  Next.js UI  ◀── Express REST/FHIR/OpenAPI ◀── PostgreSQL (Neon)
```

The backend is an npm workspace (`backend/apps/*`, `backend/packages/*`). The frontend is a
standalone Next.js package that references the backend packages via `file:` deps. The root
`package.json` is a thin, dependency-free orchestrator — it is intentionally **not** a merged
workspace.

```
backend/
  apps/api/          Express API (REST, FHIR, OpenAPI, HL7, webhooks)
  apps/worker/       node-cron scheduler + one-shot pipeline entrypoint
  packages/shared/   Types, Zod schemas, ENDPOINTS contract
  packages/db/       Prisma schema, client singleton, .env loader, seed
  packages/etl-core/ Extractors, transforms, SQL ELT, warehouse loader
  packages/dq/       Rule engine + scorecard
  packages/mdm/      Matching, clustering, survivorship + review
  packages/ml/       Deterministic risk model + patient-scoped DQ gate
  packages/analytics/KPI aggregation
  fixtures/          Synthetic source-system extracts
  infra/             Optional local Postgres/Redis/Metabase compose
frontend/            Next.js App Router UI
docs/                Architecture + how-it-works guide
scripts/setup.mjs    install → migrate → seed → pipeline
scripts/dev.mjs      API + worker + web with prefixed logs
```

## Prerequisites

- **Node.js ≥ 20**
- A PostgreSQL database — **Neon** (free tier is fine) or local Postgres
- Optional: Docker (local infrastructure), Redis, S3-compatible storage

## Quick start

```powershell
# 1. Configure the database
Copy-Item backend/.env.example backend/.env
# edit backend/.env: set DATABASE_URL (pooled) and DIRECT_URL (direct)

# 2. Install, migrate, seed and run the pipeline
npm run setup

# 3. Start API :4000, worker and web :3000
npm run dev
```

`npm run setup` runs: install both package trees → `prisma migrate deploy` → synthetic seed
(~90 s) → one-shot ETL/MDM/warehouse/DQ pipeline (2–5 min on Neon).

Useful flags: `node scripts/setup.mjs --skip-install`, `--skip-pipeline`.

### Manual steps

```powershell
npm run install:all      # backend + frontend dependencies
npm run migrate:deploy   # apply committed Prisma migrations
npm run seed             # seed synthetic OLTP + governance metadata
npm run pipeline         # ETL → MDM → warehouse → DQ → freshness → outbox
npm run dev              # all three processes
```

Run services separately if you prefer:

```powershell
npm run dev:api          # http://localhost:4000/health
npm run dev:worker       # scheduled ETL / DQ / freshness / outbox
npm run dev:web          # http://localhost:3000
```

### Run backend and frontend in separate terminals

Each side also has its own `dev` script, so you can start them independently:

```powershell
# Terminal 1 — API + worker
cd backend
npm run dev              # API :4000 + worker (prefixed logs)

# Terminal 2 — web UI
cd frontend
npm run dev              # http://localhost:3000
```

`backend` also exposes `npm run dev:api` if you want the API without the worker.

### Demo accounts

All seeded accounts share the password `Passw0rd!123`:

| Email                    | Role      | Can do                                             |
| ------------------------ | --------- | -------------------------------------------------- |
| `admin@medidata.local`   | ADMIN     | Everything                                          |
| `physician@medidata.local` | PHYSICIAN | Clinical reads, patient 360                        |
| `labtech@medidata.local` | LAB_TECH  | Labs, result release                                |
| `biller@medidata.local`  | BILLER    | Claims, insurance                                   |
| `analyst@medidata.local` | ANALYST   | Analytics + **MDM merge review**                    |
| `auditor@medidata.local` | AUDITOR   | Governance audit                                    |
| `patient@medidata.local` | PATIENT   | Portal (own linked patient record)                  |

## Scripts (run from the repo root)

| Script                  | What it does                                                       |
| ----------------------- | ------------------------------------------------------------------ |
| `npm run setup`         | Install, migrate, seed, and run the pipeline                        |
| `npm run dev`           | Run API + worker + web (`dev.mjs api web` for a subset)             |
| `npm run dev:api`       | API only — `http://localhost:4000`                                  |
| `npm run dev:worker`    | Worker only (in-process node-cron)                                  |
| `npm run dev:web`       | Next.js only — `http://localhost:3000`                              |
| `npm run pipeline`      | One-shot ETL → MDM → warehouse → DQ → freshness → outbox            |
| `npm run seed`          | Seed synthetic data                                                 |
| `npm run migrate:dev`   | Create/apply a migration locally                                    |
| `npm run migrate:deploy`| Apply committed migrations (Neon/CI)                                |
| `npm run migrate:status`| Show applied/pending migrations                                     |
| `npm test`              | Backend Vitest suite                                                |
| `npm run smoke`         | API integration smoke (supertest; no listening server required)     |
| `npm run typecheck`     | Strict TypeScript check for backend + frontend                      |
| `npm run build`         | Build backend workspaces + Next.js production build                 |
| `npm run format`        | Prettier write across the backend workspace                         |

## What to explore

- **Dashboard** — quality score, freshness, volume KPIs, MDM/review signals.
- **Patients / Patient 360** — demographics, encounters, labs, claims, audit trail.
- **Labs** — orders, results, abnormal flags, result release (lab tech/admin).
- **Billing & Insurance** — claims, invoices, policy verification.
- **Analytics** — duplicate-rate improvement, TAT, billing lag, revenue mix.
- **Governance** — catalog, glossary, lineage, quality, freshness, audit.
- **Governance → MDM** — approve/reject merge candidates in the 85–97% review band.
- **Admin → Users** — create users with roles.

API entry points: `GET /health`, `GET /openapi.json`, `/api/*`, `/fhir/Patient`,
`/fhir/Observation`, `POST /integrations/hl7/adt`, `POST /integrations/hl7/oru`,
`POST /webhooks/*` (HMAC).

## Optional services

Everything runs without these:

| Service              | Effect when unset                                                                 |
| -------------------- | --------------------------------------------------------------------------------- |
| Redis                | Worker uses in-process `node-cron`; no queue is required.                          |
| S3 bucket            | Patient portal generates synthetic PDF downloads as data URLs.                     |
| `WEBHOOK_SECRET`     | Webhook HMAC falls back to `JWT_SECRET`; unsigned inbound requests work outside prod. |
| Docker               | `infra/docker-compose.yml` provides local Postgres 16, Redis 7 and Metabase.       |

## Verification

```powershell
npm run typecheck   # backend + frontend
npm test            # 60+ unit tests (DQ, MDM, ETL, ML, analytics)
npm run smoke       # 17 API checks incl. RBAC, FHIR, HL7 ADT + ORU
```

The smoke suite restores the MDM review queue and removes HL7 test rows, so it is safe to
re-run against the demo dataset. It expects `npm run setup` (or seed + pipeline) to have run.

## Deliberate synthetic defects

The seed intentionally contains a few bad rows so governance and DQ screens are not empty:
3 duplicate patients (`MRN-900001..3`), 5 negative-turnaround lab results, and stale open
claims. The DQ scorecard is expected to report failures for those rules, and the ML gate is
patient-scoped so one bad patient does not block every risk score.

## License / disclaimer

Educational final project. Synthetic data only. Not for clinical use.
