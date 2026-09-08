# CIDB Tender API

Standalone, production-oriented **CIDB tender data service**: it ingests publicly available
Construction Industry Development Board (CIDB) tender information, normalizes it into a stable
schema, stores it in PostgreSQL, and exposes it through a versioned REST API.

First consumer: **TenderBase** — which only needs:

```env
CIDB_API_URL=https://your-cidb-api.onrender.com
CIDB_API_KEY=xxxxxxxx
```

TenderBase never scrapes CIDB directly. CIDB ingestion is an internal implementation detail
of this service.

---

## Architecture

```text
             ┌──────────────────────┐
             │         CIDB         │  feed:    https://www.cidb.org.za/tenders.json
             │                      │  listing: https://www.cidb.org.za/cidb-tenders/current-tenders/
             └──────────┬───────────┘
                        │ fetch (polite: UA, timeouts, backoff)
                        ▼
             ┌──────────────────────┐
             │  CIDB Worker         │  discover → fetch → parse → normalize → sync
             │  (Render service)   │  scheduled every 30 min (configurable)
             └──────────┬───────────┘
                        │ Prisma upserts + change detection
                        ▼
             ┌──────────────────────┐
             │   Neon PostgreSQL    │  tenders, documents, sync runs, errors, API keys
             └──────────┬───────────┘
                        │
                        ▼
             ┌──────────────────────┐
             │   Fastify REST API   │  /api/v1/* · X-API-Key auth · Swagger at /docs
             │  (Render service)   │
             └──────────┬───────────┘
                        │
                        ▼
             ┌──────────────────────┐
             │      TenderBase      │  search · filter · detail · documents
             └──────────────────────┘
```

### Stack

Node.js 20+ · TypeScript (strict) · Fastify 5 · Prisma 5 (PostgreSQL) · Zod ·
Pino · Cheerio · node-cron · Vitest · OpenAPI/Swagger · Docker · Render · Neon.

### Repository layout

```text
CIDB-API/                     (repository root)
├── src/
│   ├── api/            Fastify app, server entry, routes (health/tenders/documents/stats/admin)
│   ├── auth/           X-API-Key authentication (hashed keys, API vs ADMIN roles)
│   ├── cidb/           connector abstraction + JSON-feed & HTML parsers + normalizer
│   ├── database/       lazy Prisma client + structural DbClient contract
│   ├── services/       tender/document/sync/stats business logic
│   ├── jobs/           node-cron schedule (overlap-safe)
│   ├── schemas/        Zod request/response schemas (also generate Swagger)
│   ├── utils/          hashing, dates, retry/backoff, logging
│   ├── config.ts       validated environment configuration
│   └── worker.ts       worker entrypoint (scheduled ingestion loop)
├── prisma/             schema.prisma + migrations (0001_init)
├── tests/              unit + integration + source fixtures (captured feed + HTML)
├── scripts/            cidb-live probe, openapi export, key hashing, db verify
├── docs/openapi.yaml   generated API reference (npm run openapi:export)
├── .github/workflows/  CI: typecheck → tests → OpenAPI drift check
├── Dockerfile          shared API/worker production image
├── docker-compose.yml  local postgres + api + worker
└── render.yaml         Render Blueprint (CIDB API web service)
```

### Connector abstraction

```text
TenderSourceConnector
  ├── discover()      find raw records on the source
  ├── fetch()         enrich one record (pass-through when the listing is complete)
  ├── parse()         source payload → structured ParsedTender
  ├── normalize()     ParsedTender → validated NormalizedTender
  └── healthCheck()   source reachability + structure probe
```

`createConnector()` picks the implementation from `CIDB_SOURCE_URL`:

| Connector | Selected when | Notes |
|---|---|---|
| `CIDBJsonConnector` | URL path ends in `.json` (**default**) | The feed the CIDB website itself renders from: every record with `realstatus`, per-document timestamps and document links. Paginated server-side, so all pages are walked. |
| `CIDBHtmlConnector` | URL is an `http(s)` page | Server-rendered listing tables (`src/cidb/parser.ts`). |
| `FileFixtureConnector` | URL starts with `file:` | Offline replay of a captured feed **or** listing page — same pipeline, frozen input. Local testing only. |

> **Why the feed is the default.** The public page
> `https://www.cidb.org.za/cidb-tenders/current-tenders/` builds its table in the
> browser from `https://www.cidb.org.za/tenders.json` (`loadDataTable()` in the page
> source). The HTML the server sends therefore has an empty `<tbody>`: scraping it
> returns zero records, which the suspicious-result guards correctly refuse to write.
> The feed is the authoritative dataset — it carries statuses the HTML page never
> exposes, plus per-document timestamps and links embedded in each description.
>
> **The feed is paginated.** `loadDataTable()` requests it with
> `{page, limit, search_item, region, status}` (`limit` is the page-size select:
> 10/25/50/100) and builds its pager from `tender_count`, the total the server
> declares. A single unparameterized request therefore returns only the first page —
> 25 rows while `tender_count` said 33 — so `fetchFeedPages()` walks the pages,
> merges them on the feed's own `tender_ID`, and stops when the declared total is
> reached or a page adds nothing new (which also keeps it safe, and loud, if the
> source ever ignores the paging parameters). Tune with `CIDB_FEED_PAGE_SIZE` /
> `CIDB_FEED_MAX_PAGES`; a shortfall is reported as a sync warning rather than
> silently under-collecting.

A future `CIDBOfficialApiConnector` (or awarded/archived/cancelled connectors) can
replace any of these without touching the public API or database model.

---

## Quick start (local)

Prerequisites: Node.js 20+, and PostgreSQL (local, `docker compose`, or Neon).

```bash
git clone https://github.com/tenderbase/CIDB-API.git && cd CIDB-API
npm install
cp .env.example .env            # fill in DATABASE_URL + API_KEY + ADMIN_API_KEY

npx prisma generate
npx prisma migrate dev          # creates tables locally

npm run dev                     # API on http://localhost:3000
npm run dev:worker              # worker (scheduled sync) in another terminal
```

Swagger UI: **http://localhost:3000/docs** — click **Authorize**, paste a key
(`test-api-key` / `test-admin-key` in offline mode) and the `X-API-Key` header is
added to every *Try it out* request. The key persists across reloads.

### Offline testing mode (no database, no network)

For a zero-dependency test drive, the API can run on an in-memory database and
ingest a frozen CIDB listing file through the exact same pipeline:

```bash
PORT=3000 DB_MODE=memory \
CIDB_SOURCE_URL='file:./tests/fixtures/cidb-tenders.json' \
API_SYNC_ON_START=true API_KEY=test-api-key ADMIN_API_KEY=test-admin-key \
CORS_ORIGIN='*' npm run dev
```

Both fixture formats work — `tests/fixtures/cidb-tenders.json` is a snapshot of the
live feed, `tests/fixtures/cidb-current.html` a captured listing page.

Then:

```bash
curl http://localhost:3000/api/v1/health
curl -H "X-API-Key: test-api-key" "http://localhost:3000/api/v1/tenders?status=OPEN"
curl -H "X-API-Key: test-api-key" http://localhost:3000/api/v1/stats
curl -X POST -H "X-API-Key: test-admin-key" http://localhost:3000/api/v1/admin/sync
```

`DB_MODE=memory` and `file:` sources are **local testing only** — data lives in the
process heap and is not persisted. Production always uses `DB_MODE=postgres`
(the default) with the live CIDB source.

### Environment variables

| Variable | Service | Default | Description |
|---|---|---|---|
| `DATABASE_URL` | api, worker | — | PostgreSQL connection string (Neon in prod). Required. |
| `DATABASE_URL_POOLED` | api | — | Optional Neon pooler URL (overrides `DATABASE_URL` when set). |
| `API_KEY` | api | — | Read-API secret; seeded into `ApiKey` as `env-default` (hashed). |
| `ADMIN_API_KEY` | api | — | Admin secret; seeded as `env-admin` (hashed). |
| `PORT` | api | `3000` | Listen port (Render injects this). |
| `PUBLIC_BASE_URL` | api | — | Public origin, e.g. `https://cidb-tender-api.onrender.com`. Advertised in the OpenAPI `servers` at `/docs` (absolute URLs for external clients); empty keeps the relative `/api/v1` server. |
| `CORS_ORIGIN` | api | — | Comma-separated allowlist, e.g. `https://tenderbase.app`. |
| `CIDB_SOURCE_URL` | worker | `https://www.cidb.org.za/tenders.json` | Source to ingest: the machine-readable feed (default), an HTML listing, or `file:<path>` offline. Selects the connector. |
| `CIDB_LISTING_URL` | worker | `https://www.cidb.org.za/cidb-tenders/current-tenders/` | Public page records are attributed to (the `sourceUrl` field in API responses). |
| `CIDB_FEED_PAGE_SIZE` | worker | `100` | Records requested per feed page (`limit`). |
| `CIDB_FEED_MAX_PAGES` | worker | `50` | Safety cap on feed pages walked per sync. |
| `CIDB_SYNC_CRON` | worker | `*/30 * * * *` | Sync schedule (cron expression). |
| `SYNC_ON_START` | worker | `true` | Run one sync immediately on boot. |
| `API_SYNC_ON_START` | api | `false` | Run one sync when the API boots (dev convenience, usually with `DB_MODE=memory`). |
| `MISSING_CLOSE_GRACE_DAYS` | worker | `3` | Days a tender may vanish before marked `CLOSED` (`0` disables). |
| `MIN_EXPECTED_RECORDS` | worker | `1` | Suspicious-result floor. |
| `MAX_DROP_RATIO` | worker | `0.8` | Fail syncs dropping more than this vs last good run. |
| `CLOSING_SOON_DAYS` | both | `7` | Window for `CLOSING_SOON` derivation. |
| `REQUEST_TIMEOUT_MS` | worker | `30000` | Per-request timeout against CIDB. |
| `MAX_RETRIES` | worker | `3` | Retries for transient failures. |
| `RETRY_BASE_DELAY_MS` | worker | `1000` | Backoff base (exponential + jitter). |
| `REQUEST_DELAY_MS` | worker | `1500` | Polite delay between source requests. |
| `CIDB_USER_AGENT` | worker | `CIDB-Tender-API/1.0 …` | Descriptive User-Agent. |
| `RATE_LIMIT_MAX` / `RATE_LIMIT_WINDOW_MS` | api | `300` / `60000` | Global rate limit. |
| `ADMIN_RATE_LIMIT_MAX` / `ADMIN_RATE_LIMIT_WINDOW_MS` | api | `60` / `60000` | Stricter admin limit. |
| `LOG_LEVEL` | both | `info` | Pino level (`silent` disables). |

Boolean variables accept `true`/`false`, `1`/`0`, `yes`/`no`, `on`/`off`
(case-insensitive); an unset or empty value means the documented default and
anything else fails at boot with `Invalid environment configuration`.

Never commit `.env`. Never expose `DATABASE_URL` or keys through the API.

### Prisma commands

```bash
npx prisma generate        # generate client (also runs in Docker build)
npx prisma migrate dev     # local development migrations
npx prisma migrate deploy  # production migrations (Render dockerCommand)
npx prisma studio          # inspect the database
```

Production never runs `migrate reset`. Migrations are explicit files under `prisma/migrations/`.

### Running tests

```bash
npm test                   # full suite: unit + integration (144 tests)
npm run test:watch         # watch mode
npm run test:cidb-live     # MANUAL live probe of the real CIDB site (not part of CI)
```

### Production build & start

```bash
npm run build              # tsc → dist/
npm start                  # API (dist/api/server.js)
npm run worker             # worker loop (dist/worker.js)
npm run worker:once        # single sync, then exit
```

---

## Neon setup

1. Create a Neon project at https://neon.tech and a PostgreSQL database.
2. Copy the pooled or direct connection string.
3. Set `DATABASE_URL` in Render (both API and worker services use the same value).
4. Run migrations once (Render dockerCommand does this automatically):
   `npx prisma migrate deploy`.
5. Verify: `DATABASE_URL="..." npm run verify:db` (add `-- --write` for a canary write check).

Prisma works with Neon over standard PostgreSQL TCP; for high concurrency set
`DATABASE_URL_POOLED` to the Neon pooler string.

---

## API reference

Base path: `/api/v1`. All errors use `{ "error": { "code": "...", "message": "..." } }`.

| Docs surface | URL | Notes |
|---|---|---|
| Interactive (Swagger UI) | `/docs` | *Try it out* enabled; `X-API-Key` persists across reloads. |
| OpenAPI JSON | `/docs/json` | Served live from the route schemas. |
| OpenAPI YAML | `/docs/yaml` | Same document as YAML. |
| Committed spec | `docs/openapi.yaml` | Generated by `npm run openapi:export`; CI fails on drift. |
| Service index | `/` | Public JSON with links to docs/health/API. |

`PUBLIC_BASE_URL` (e.g. `https://cidb-tender-api.onrender.com`) makes the document
advertise absolute `servers` URLs so generated clients and Postman collections work
outside the browser; unset keeps the relative `/api/v1` server.

### Authentication

```http
X-API-Key: YOUR_API_KEY
```

- Read endpoints (`/tenders/*`, `/stats`, `/health/detailed`) accept any active key.
- Admin endpoints (`/admin/*`) require an `ADMIN`-role key (`403` otherwise).
- Keys are stored as SHA-256 hashes only; `lastUsedAt` is stamped on use.

### Endpoints

| Method | Path | Auth | Description |
|---|---|---|---|
| GET | `/api/v1/health` | public | Liveness probe (Render health check). |
| GET | `/api/v1/health/detailed` | admin | DB, source, worker, record counts. |
| GET | `/api/v1/tenders` | api | Paginated list + search/filters/sort. |
| GET | `/api/v1/tenders/search?q=` | api | Search bid/title/description/organisation/location. |
| GET | `/api/v1/tenders/closing-soon?days=7` | api | Open tenders closing within N days. |
| GET | `/api/v1/tenders/province/:province` | api | Filter by province. |
| GET | `/api/v1/tenders/grade/:grade` | api | Filter by CIDB grade (`6` also matches `5-7`). |
| GET | `/api/v1/tenders/class/:class` | api | Filter by CIDB class (`GB`, `CE`, …). |
| GET | `/api/v1/tenders/:id` | api | Full detail + documents (id or externalId). |
| GET | `/api/v1/tenders/:id/documents` | api | Tender documents. |
| GET | `/api/v1/stats` | api | Totals, freshness, byProvince/byGrade/byClass. |
| POST | `/api/v1/admin/sync` | admin | Trigger async sync → `{ status, syncId }` (202). |
| GET | `/api/v1/admin/sync/history` | admin | Recent sync runs. |
| GET | `/api/v1/admin/sync/:id` | admin | One run + counters + recent errors. |
| GET | `/api/v1/admin/errors` | admin | Recent ingestion errors. |

List query parameters: `page` (default 1) · `limit` (default 25, max 100) · `search` ·
`status` (`OPEN` includes `CLOSING_SOON`) · `province` · `cidbGrade` · `cidbClass` ·
`organisation` · `publishedFrom/To` · `closingFrom/To` · `sort` (`publishedDate`,
`closingDate`, `createdAt`, `updatedAt`, `bidNumber`, `title`) · `order` (`asc`/`desc`).

### Examples

```bash
BASE=https://YOUR-API.onrender.com

curl -H "X-API-Key: $CIDB_API_KEY" "$BASE/api/v1/tenders?status=OPEN&limit=5"

curl -H "X-API-Key: $CIDB_API_KEY" \
  "$BASE/api/v1/tenders?province=KwaZulu-Natal&cidbGrade=6&status=OPEN"

curl -H "X-API-Key: $CIDB_API_KEY" "$BASE/api/v1/tenders/search?q=road%20construction"

curl -H "X-API-Key: $CIDB_API_KEY" "$BASE/api/v1/tenders/closing-soon?days=7"

curl -H "X-API-Key: $CIDB_API_KEY" "$BASE/api/v1/stats"

# Manual sync (admin key). Returns immediately; poll the sync id.
curl -X POST -H "X-API-Key: $ADMIN_API_KEY" "$BASE/api/v1/admin/sync"
curl -H "X-API-Key: $ADMIN_API_KEY" "$BASE/api/v1/admin/sync/<syncId>"
```

### Response shape (tender)

```json
{
  "id": "…",
  "source": "CIDB",
  "externalId": "CIDB-CIDB-004-2627",
  "bidNumber": "CIDB 004 2627",
  "title": "…",
  "description": "…",
  "organisation": "Construction Industry Development Board",
  "province": "Gauteng",
  "status": "OPEN",
  "publishedDate": "2026-06-01T00:00:00.000Z",
  "closingDate": null,
  "cidbGrade": null,
  "cidbClass": [],
  "contact": { "name": null, "email": null, "phone": null },
  "documents": [{ "name": "GET BID DOCUMENT", "documentType": "BID_DOCUMENT", "url": "…" }],
  "sourceUrl": "https://www.cidb.org.za/…",
  "firstSeenAt": "…",
  "lastSeenAt": "…",
  "createdAt": "…",
  "updatedAt": "…"
}
```

---

## Ingestion details

**Pipeline:** start `SyncRun` → discover → fetch → parse → normalize → Zod-validate →
`externalId` + `rawHash` → upsert with change detection → documents → finalize.

- **Identity:** `(source, externalId)` unique. `externalId` derives from the normalized
  bid number (`CIDB-CIDB-004-2627`); hash fallback when no bid number exists. Repeated
  syncs never duplicate; in-run duplicates get deterministic `-2`, `-3` suffixes.
- **Change detection:** `rawHash` (SHA-256 over canonical source content). Unchanged →
  touch `lastSeenAt` only; changed → update + replace documents.
- **Documents:** classified (`BID_DOCUMENT`, `ADDENDUM`, `OPENING_REGISTER`,
  `BRIEFING_NOTE`, `PRICING_SCHEDULE`, `OTHER`) with file name + MIME type. V1 stores
  metadata/links (no PDF download); the model already carries `downloadStatus`,
  `contentHash`, `fileSize` for the future pipeline.
- **Status:** the feed declares each record's `realstatus` (`Open`/`Closed`/`Awarded`),
  which is mapped onto the schema (`OPEN`/`CLOSED`/`AWARDED`/`CANCELLED`) and preserved in
  `rawData.sourceStatusRaw`. Known closing dates refine `OPEN` to `CLOSING_SOON`/`CLOSED`.
  The API additionally re-derives display status at read time so a passed closing date is
  never reported as open. Terminal states are never invented — and when the source
  declares one, it wins over inference (the feed publishes no closing dates, so inference
  alone would call every awarded tender `OPEN`).
- **Documents from the feed:** advert → `GET BID DOCUMENT` (`BID_DOCUMENT`), specification →
  `GET ADDENDUM` (`ADDENDUM`), awards → `BID OPENING REGISTER` (`OPENING_REGISTER`),
  briefing → `BRIEFING NOTE` (`BRIEFING_NOTE`) — the exact labels the website renders.
  Anchors embedded in a description (pricing schedules, BOQs) are extracted as documents
  too, and the description is stored as clean text.
- **Removed tenders:** tenders absent from the source longer than
  `MISSING_CLOSE_GRACE_DAYS` are marked `CLOSED` (only on successful syncs).
- **Failure safety:** HTTP errors, retries with exponential backoff, and structural
  validation (`SOURCE_STRUCTURE_CHANGED`). Zero-result or collapsing scrapes fail the
  sync (`SUSPICIOUS_ZERO_RESULTS`/`SUSPICIOUS_DROP`) **before any writes** — existing
  data is never replaced by a bad scrape, and the API keeps serving stored data.

**Best-effort inference** (province from city mentions, grade/class/closing-date/contact
extraction) is flagged in `rawData.inferred`; raw values are always preserved
(`cidbGradeRaw`, `cidbClassRaw`, `rawData`, `sourceUrl`).

### Bulk export (dataset snapshots)

`scripts/ingest-export.ts` runs the real pipeline end to end and writes a normalized
dataset instead of touching a database — useful for one-off extractions, source
verification and CI artifacts:

```bash
# live feed, all pages (default) → data/cidb-tenders-<date>.json|.csv + ingest-summary.json
npx tsx scripts/ingest-export.ts
npx tsx scripts/ingest-export.ts --limit=25 --max-pages=10   # smaller feed pages

# replay a captured snapshot offline; keep the raw payload alongside the dataset
npx tsx scripts/ingest-export.ts --url=file:./snapshots/<stamp>/source-html/tenders.json --raw=none

# crawl a server-rendered HTML listing instead (paginates up to --max-pages)
npx tsx scripts/ingest-export.ts --url=https://www.cidb.org.za/cidb-tenders/current-tenders/
```

Every record keeps `sourceUrl` pointing at the public listing page
(`CIDB_LISTING_URL`), with the feed URL retained in `rawData.sourceExtra.feedUrl`.

The GitHub Actions workflow **Ingest CIDB tenders** (`.github/workflows/ingest.yml`)
runs this from a GitHub runner — which can reach `cidb.org.za` from environments that
cannot — on every push touching `src/cidb/**`, `scripts/ingest-export.ts` or the
workflow itself, and can also be started manually (Actions → Run workflow). Each run
publishes `data/` plus the raw source payload as artifacts and commits a timestamped
copy under `snapshots/` to the branch, so results stay inspectable without downloading
artifact storage. With the `DATABASE_URL` repository secret set, `target=database` (or
`both`) additionally migrates and syncs into the live database.

---

## Render deployment

One Blueprint (`render.yaml` at the repo root) creates the services, built from the
shared Dockerfile. The Blueprint ships the API web service only (background workers
are paid-only on Render); syncs are triggered over HTTP — see the `render.yaml`
header comment for the scheduler call.

**Option A — Blueprint (recommended)**

1. Render Dashboard → New → Blueprint → select this repo and branch.
2. When prompted, enter the secrets: `DATABASE_URL` (Neon **direct**, non-pooler
   string), `API_KEY`, `ADMIN_API_KEY` (two **different** random strings) and
   `CORS_ORIGIN` (browser origins allowed to call the API, e.g.
   `https://app.tenderbase.example`; server-to-server callers are always allowed,
   so leave it empty if only backends consume the API).
3. Deploy. The API gets a public `https://cidb-tender-api.onrender.com` URL —
   check `PUBLIC_BASE_URL` in `render.yaml` still matches it (that is what the
   OpenAPI `servers` at `/docs` advertise).
4. Schedule syncs from any cron service, since the Blueprint ships no background
   worker (they are paid-only on Render):
   `POST /api/v1/admin/sync` with `X-API-Key: <ADMIN_API_KEY>` every 30 minutes.
   The call returns `202` immediately and is overlap-safe, so retries are harmless.

**Option B — manual**

- **API (Web Service):** Runtime Docker · Root Directory `.` (repo root) · Region Frankfurt
  (closest to SA) · Docker Command
  `sh -c "npx prisma migrate deploy && node dist/api/server.js"` · Health Check Path
  `/api/v1/health` · vars `DATABASE_URL`, `API_KEY`, `ADMIN_API_KEY`, `LOG_LEVEL`,
  `PUBLIC_BASE_URL` (the service URL) and optionally `CORS_ORIGIN`.
- **Worker (Background Worker, optional — paid plan):** Runtime Docker · Root
  Directory `.` (repo root) · same region · Docker Command
  `sh -c "npx prisma migrate deploy && node dist/worker.js"` · vars `DATABASE_URL`,
  `CIDB_SYNC_CRON`, `SYNC_ON_START`, `LOG_LEVEL`. No health check — workers have no
  HTTP port. Without a worker, trigger syncs with `POST /api/v1/admin/sync`.

Notes:

- The Docker Command **must** start with `npx prisma migrate deploy &&` — that is what
  creates the tables. Without it the services exit with `DATABASE_NOT_MIGRATED`
  (fail-fast, by design).
- Background workers are paid-only on Render (no free tier); the web service can
  start on Starter.
- After the worker's first sync completes, give TenderBase `CIDB_API_URL` + `CIDB_API_KEY`.

---

## TenderBase integration

```ts
const res = await fetch(`${process.env.CIDB_API_URL}/api/v1/tenders?status=OPEN&limit=25`, {
  headers: { 'X-API-Key': process.env.CIDB_API_KEY! },
});
const { data, pagination } = await res.json();
```

Field mapping:

| CIDB API | TenderBase |
|---|---|
| `id` | external source id |
| `source` | source (`CIDB`) |
| `bidNumber` | tender number |
| `title` / `description` | title / description |
| `organisation` | organisation |
| `province` / `location` / `municipality` | province / location / municipality |
| `publishedDate` / `closingDate` | published / closing date |
| `cidbGrade` / `cidbClass` | CIDB grade / class |
| `documents[]` (`name`, `url`, `documentType`, `mimeType`) | documents |
| `sourceUrl` | original source link |
| `status` | status |
| `lastSeenAt` / stats `lastSuccessfulSync` | data freshness ("Updated X ago") |

Always attribute the source (`source`, `sourceUrl`) — TenderBase is not the publisher.

---

## Testing & verification

- `npm test` — 191 tests: feed mapper (statuses, documents, description HTML, probing),
  parser/normalizer/dates/grades/classes/hashing/retry/query/config units; migration DDL
  executed on real PostgreSQL (PGlite); sync pipeline (idempotency, change detection,
  duplicates, partial failure, suspicious guards, missing-as-closed, overlap/orphan
  handling) including an end-to-end run over a captured live feed snapshot; full API suite
  (auth, validation, filters, pagination, serialization, admin lifecycle); OpenAPI contract
  suite (valid 3.0 document, summaries/tags/operationIds, real response descriptions,
  documented 401/403/404/409/429, `/docs`, `/docs/json`, `/docs/yaml`).
- `npm run test:cidb-live` — optional manual probe of the live CIDB site.
- `npm run verify:db` — run once against Neon to smoke-test every query path.
- `npm run openapi:export` — regenerates `docs/openapi.yaml` from the live app
  (servers: the public deployment URL plus the relative `/api/v1`).
  `npm run openapi:export:local` writes the relative-only variant.
- `npm run openapi:check` — regenerates the document and fails when
  `docs/openapi.yaml` drifted from the code. CI runs this on every push/PR
  (`.github/workflows/ci.yml`: typecheck → tests → OpenAPI drift).

**Design note — testability without a live database:** application code depends on a
narrow structural `DbClient` interface (`src/database/types.ts`), not on the generated
Prisma client. Production injects the real `PrismaClient`; tests inject a faithful
in-memory implementation. This keeps the public API, Prisma schema, and migrations
fully standard while allowing the whole suite to run anywhere.

## Troubleshooting

| Symptom | Likely cause / fix |
|---|---|
| `DATABASE_URL is required` | `.env` missing — copy `.env.example`. |
| `401 UNAUTHORIZED` everywhere | `API_KEY`/`ADMIN_API_KEY` unset or wrong `X-API-Key` header. |
| `403 FORBIDDEN` on `/admin/*` | The key is valid but has the `API` role; use `ADMIN_API_KEY`. Also logged as `API_KEY_IDENTICAL` when both env secrets are the same string. |
| Browser calls fail, `curl` works | `CORS_ORIGIN` does not list the calling origin (no `Origin` header = allowed, which is why server-to-server works). |
| `/docs` loads but *Try it out* returns 401 | Click **Authorize** and paste the key — the docs UI never reads secrets from the environment. |
| `/docs` slow or 503 on first hit | Render free plan sleeps after ~15 min idle; the first request wakes the service (~30-60 s). |
| Sync `FAILED` + `SOURCE_REQUEST_FAILED` | CIDB unreachable/blocked; check `CIDB_SOURCE_URL`, timeouts, retry settings. It retries with backoff automatically. |
| Sync `FAILED` + `SOURCE_STRUCTURE_CHANGED` | CIDB changed the source; run `npm run test:cidb-live`, then update `src/cidb/jsonFeed.ts` (feed) or `src/cidb/parser.ts` (HTML) + fixtures. |
| Sync discovers **0 records** from the listing page | Expected: `/cidb-tenders/current-tenders/` renders its rows in the browser, so the served HTML has an empty `<tbody>`. Ingest the feed instead — `CIDB_SOURCE_URL=https://www.cidb.org.za/tenders.json` (the default). |
| Fewer tenders than the site shows | The feed paginates: `tender_count` declares the total, one page returns at most `limit` rows. Paging is automatic — check the sync warning, then raise `CIDB_FEED_PAGE_SIZE`/`CIDB_FEED_MAX_PAGES`. |
| Sync `FAILED` + `SUSPICIOUS_*` | Scrape collapsed vs history; data untouched by design. Investigate source, then re-run. |
| `409 SYNC_ALREADY_RUNNING` | A sync is in flight; poll `GET /admin/sync/history` instead. |
| Prisma `P1001`/`P1000` on Render | Wrong `DATABASE_URL` or Neon sleeping/firewalled; verify with `verify:db`. |
| `DATABASE_NOT_MIGRATED` on boot | Docker Command is missing `npx prisma migrate deploy` — the database has no tables. The Blueprint sets this automatically; for manual services set it under Settings → Docker Command (see below). |
| `Can't reach database server` on Render | The Neon **pooler** endpoint is unreachable. Use the **direct** (non-pooler) connection string for `DATABASE_URL`. |
| `API_KEY_IDENTICAL` / `P2002 keyHash` at boot | `API_KEY` and `ADMIN_API_KEY` are identical (or a stale row holds the hash). Generate two different secrets; if rotation is blocked, delete the stale row (`DELETE FROM "ApiKey" WHERE name='env-default'`) and redeploy. |
| Render deploy `Failed` / `Service Unavailable` | The container isn't listening (crash loop / wrong Docker Command / `DATABASE_URL` wrong) — check the service Events + Logs tabs. The app listens on Render's injected `PORT` automatically. |
| Empty `/tenders` after deploy | Worker hasn't synced yet — check worker logs, then `POST /admin/sync`. |

**Render Docker Commands** (the Blueprint sets these; for manual services set them under
service Settings → Docker Command):

- API: `sh -c "npx prisma migrate deploy && node dist/api/server.js"`
- Worker: `sh -c "npx prisma migrate deploy && node dist/worker.js"`

---

## Security

Hashed API keys (SHA-256, domain-separated) · separate admin role · Zod input
validation everywhere · whitelisted sort fields · global + stricter admin rate limits ·
1 MB body cap · Helmet headers · configurable CORS allowlist · parameterized Prisma
queries · uniform error envelopes · no secrets in logs · no production stack traces.

## License

Private — all rights reserved.
