# Arena REST API & analysis semantics

Arena's fork of the open-source **OpenSEO** ("open source alternative to Semrush and Ahrefs").

- **Fork:** `stationfy/open-seo` (public, parent `every-app/open-seo`, MIT)
- **Stack:** TypeScript · TanStack Start · Vite · Drizzle · `pnpm@10.30.1` · runs inside the **Cloudflare Workers runtime (workerd)**
- **Produced by:** [WID-2962](https://linear.app/arena/issue/WID-2962)
- **Consumed by:** WID-2805 (Arena-controlled exposure layer)

> [!WARNING] Deployment constraint for WID-2805
> This app is not a plain Node service. `import { env } from "cloudflare:workers"` is load-bearing throughout, and Site Audit depends on **Cloudflare Workflows** (`SITE_AUDIT_WORKFLOW`) plus a **Durable Object** (`AUDIT_SCRATCHPAD`). Arena must run it on Cloudflare Workers or the workerd-based Docker image — **not** plain ECS/Lambda.

---

## Local setup (Postgres, no auth)

Upstream defaults to Cloudflare D1. Postgres is opt-in and reachable **only** through the `HYPERDRIVE` binding — `src/db/provider.ts` throws if it is absent, and there is no direct-connection fallback.

> [!NOTE] `docker compose up` will not satisfy a Postgres requirement
> `compose.yaml` runs the D1 path (its only volume is miniflare state). Postgres requires the `pnpm dev` path.

```sh
docker run --name openseo-postgres \
  -e POSTGRES_USER=openseo -e POSTGRES_PASSWORD=openseo -e POSTGRES_DB=openseo \
  -p 5433:5432 -d postgres:16

POSTGRES_DATABASE_URL=postgres://openseo:openseo@localhost:5433/openseo pnpm db:migrate:pg
pnpm dev   # http://localhost:3001
```

1. Uncomment the `hyperdrive` block in `wrangler.jsonc` (ships commented out; `localConnectionString` already points at the container above).
2. `.env.local`:
   ```
   DATAFORSEO_API_KEY=<base64 of email:password>
   AUTH_MODE=local_noauth
   DATABASE_PROVIDER=postgres
   ```

`AUTH_MODE=local_noauth` is an upstream feature, not a patch. It injects an admin user (`local-admin` / `admin@localhost`) and auto-creates its organization and a `Default` project on first request — verified as real rows in Postgres.

Verify with `curl localhost:3001/api/health` → `authMode: "local_noauth"`, `dataforseo: "Set"`, `database: "ok"`.

> [!IMPORTANT] DataForSEO is a hard dependency
> All three analyses proxy DataForSEO and **cost real money per call**. Domain Overview is ~100–300 credits and cached 12h per domain.

---

## The TanStack wire format

The browser never calls a REST endpoint. Every interaction is a TanStack Start **server function** call, and the request self-describes which internal function it targets:

```
POST /_serverFn/<base64url>
```

Base64url-decoding that segment yields the source location directly:

```json
{
  "file": "/src/serverFunctions/domain.ts?tss-serverfn-split",
  "export": "getDomainOverview_createServerFn_handler"
}
```

Request and response bodies are **seroval**-encoded (`{"t":..,"i":..,"p":{"k":[keys],"v":[values]}}`), wrapping `{data}` on the way in and `{result, error, context}` on the way out.

Decoding the segment is therefore the whole mapping technique — no guesswork required:

```js
JSON.parse(
  Buffer.from(seg.replace(/-/g, "+").replace(/_/g, "/"), "base64").toString(),
);
```

### Call chain

```
route (src/routes/_project/p/$projectId/*)
  → server function (src/serverFunctions/*.ts)
      ensureUserMiddleware        → resolves user + authorizes projectId
      requireProjectContext       → narrows context, adds projectId
  → service (src/server/features/*/services/*Service.ts)
  → repository / DataForSEO
```

---

## Browser request → internal function map

Observed live against `arena.im` on 2026-08-17.

### Domain Overview — `/p/$projectId/domain`

| Server function               | Internal function                    | Sync?   | Observed     |
| ----------------------------- | ------------------------------------ | ------- | ------------ |
| `getDomainOverview`           | `DomainService.getOverview`          | ✅ sync | 88 ms cached |
| `getDomainKeywordsPage`       | `DomainService.getKeywordsPage`      | ✅ sync | 45 ms cached |
| `getDomainKeywordSuggestions` | `DomainService.getSuggestedKeywords` | ✅ sync | —            |
| `getDomainPagesPage`          | `DomainService.getPagesPage`         | ✅ sync | —            |

Result for `arena.im`: 18,891 est. organic traffic, 859 organic keywords.

### Backlinks — `/p/$projectId/backlinks`

| Server function                | Internal function                                | Sync?   | Observed |
| ------------------------------ | ------------------------------------------------ | ------- | -------- |
| `getBacklinksOverview`         | `BacklinksService.profileOverview` → `.overview` | ✅ sync | 1,998 ms |
| `getBacklinksRows`             | `BacklinksService.profileBacklinksPage`          | ✅ sync | 3,183 ms |
| `getBacklinksReferringDomains` | `BacklinksService.profileReferringDomainsPage`   | ✅ sync | —        |
| `getBacklinksTopPages`         | `BacklinksService.profileTopPagesPage`           | ✅ sync | —        |

Result for `arena.im`: 16,016 backlinks, 2,048 referring domains, rank 51, spam score 12.0.

The web UI passes `{ hideSpam: false }` so the implicit DataForSEO spam cutoff stays off; MCP and other callers get the default cutoff of 40.

### Site Audit — `/p/$projectId/audit`

| Server function    | Internal function                                     | Sync?        | Observed             |
| ------------------ | ----------------------------------------------------- | ------------ | -------------------- |
| `startAudit`       | `AuditService.startAudit` (+ `resolveAuditLimitTier`) | ❌ **async** | 609 ms → `{auditId}` |
| `getAuditStatus`   | `AuditService.getStatus`                              | ✅ sync      | 32–68 ms             |
| `getCrawlProgress` | `AuditService.getCrawlProgress`                       | ✅ sync      | 23–97 ms             |
| `getAuditResults`  | `AuditService.getResults`                             | ✅ sync      | 98 ms                |
| `getAuditHistory`  | `AuditService.getHistory`                             | ✅ sync      | —                    |
| `deleteAudit`      | `AuditService.remove`                                 | ✅ sync      | —                    |

---

## Execution & completion semantics

### Domain Overview and Backlinks — synchronous

The initiating request returns the complete result inline. **By the time it responds, the data is already persisted** — nothing further to poll.

Caching, not async work, is the caller-visible subtlety:

- Domain Overview is cached **12 hours per domain**. A repeat call inside that window returns in ~90 ms and spends no credits. Treat `fetchedAt` in the response as the real data age.
- Backlinks results are cached too; the first uncached call is the 2–3 s one.

### Site Audit — asynchronous

`startAudit` returns `{ auditId }` **only**. Results are _not_ persisted when it responds — it inserts the `audits` row and then creates a Cloudflare Workflow instance that does the crawl.

**Verified locally:** Cloudflare Workflows _do_ execute under `pnpm dev` (miniflare). A 10-page crawl of `arena.im` completed in **7.2 s** (browser) and **10.5 s** (REST), writing 10 `audit_pages` and 38 `audit_issues`.

#### Detecting completion

Completion is a **status column in Postgres**, and the status vocabulary is a closed enum:

```ts
status: text("status", { enum: ["running", "completed", "failed"] })
  .notNull()
  .default("running");
```

| Column                                                | Meaning                                                                                                |
| ----------------------------------------------------- | ------------------------------------------------------------------------------------------------------ |
| `audits.status`                                       | `running` → `completed` \| `failed`                                                                    |
| `audits.current_phase`                                | `discovery` → … → `completed`; retains the dying phase on failure                                      |
| `audits.completed_at`                                 | null until terminal                                                                                    |
| `audits.workflow_instance_id`                         | the Cloudflare Workflow instance (equals the audit id in practice)                                     |
| `audits.error_code` / `error_detail` / `failed_phase` | populated only when `status = "failed"`; `error_code` is a closed vocabulary from `classifyAuditError` |
| `audits.pages_crawled` / `pages_total`                | progress counters                                                                                      |

Results land in `audit_pages`, `audit_issues`, and `audit_lighthouse_results` (all FK → `audits.id`, `ON DELETE CASCADE`).

> [!IMPORTANT] Poll the status endpoint, not the database
> `AuditService.getStatus` **lazily reconciles** an audit whose Workflow instance died without marking itself failed (platform OOM, CPU limit, deploy reset, retention expiry). A caller that polls the `audits` row directly bypasses that self-healing and can sit on a zombie `running` row until the cron watchdog sweeps it.
>
> The watchdog (`reconcileStaleAudits`, cron `*/5 * * * *`) only considers audits **running longer than 15 minutes** (`STALE_RUNNING_AFTER_MS`), with a 10-minute grace before an instance counts as lost (`INSTANCE_LOST_GRACE_MS`). So the worst case for DB-only polling is a ~15-minute hang; the status endpoint resolves it on the next poll.

Recommended polling loop: `POST /api/rest/audits/start` → poll `/api/rest/audits/status` every 2 s until `status !== "running"` → on `completed`, `POST /api/rest/audits/results`. `/api/rest/audits/crawl-progress` gives live per-page progress during the crawl.

---

## The REST API (added for WID-2962)

Ten routes under `/api/rest/`, added in the fork. They call the **same services** the server functions call, so the analysis data they return is identical. The transport differs: a plain JSON `POST` returning a `{"data": ...}` envelope, rather than `/_serverFn/<base64url>` returning a seroval-encoded `{result, error, context}`.

> [!CAUTION] Gated to `local_noauth`
> Every route returns **403 FORBIDDEN** unless `AUTH_MODE=local_noauth`. The gate runs _before_ body parsing, so a disabled instance returns a uniform 403 and never reveals route behavior. A deploy that flips `AUTH_MODE` disables the whole surface automatically.

All routes are `POST` with a JSON body — deliberately mirroring the internal server functions 1:1 rather than inventing a REST shape. WID-2805's exposure layer is the right place to present a friendlier contract.

| Route                             | Internal function                                          |
| --------------------------------- | ---------------------------------------------------------- |
| `/api/rest/projects/list`         | `ProjectService.listProjectsEnsuringOne`                   |
| `/api/rest/projects/create`       | `ProjectService.createProject`                             |
| `/api/rest/domain/overview`       | `DomainService.getOverview`                                |
| `/api/rest/backlinks/overview`    | `BacklinksService.profileOverview` → `.overview`           |
| `/api/rest/backlinks/profile`     | `BacklinksService.profileOverview` (full profile + trends) |
| `/api/rest/audits/start`          | `AuditService.startAudit`                                  |
| `/api/rest/audits/status`         | `AuditService.getStatus`                                   |
| `/api/rest/audits/results`        | `AuditService.getResults`                                  |
| `/api/rest/audits/history`        | `AuditService.getHistory`                                  |
| `/api/rest/audits/crawl-progress` | `AuditService.getCrawlProgress`                            |

`projects/list` creates a default project when the org has none, so a caller can bootstrap a `projectId` in one call.

### Envelope

Success `{"data": ...}`; failure `{"error": {"code": ..., "message"?: ...}}` with the code mapped to an HTTP status (`NOT_FOUND`→404, `VALIDATION_ERROR`→400, `FORBIDDEN`→403, `*_BILLING_ISSUE`/`INSUFFICIENT_CREDITS`→402, `AUDIT_*`/`CONFLICT`→409, `CRAWL_TARGET_BLOCKED`→422, `RATE_LIMITED`→429, `UPSTREAM_UNAVAILABLE`/`DATAFORSEO_AUTH_FAILED`→502). Unknown errors collapse to `INTERNAL_ERROR` without echoing their message, so an upstream URL or credential cannot leak.

### Implementation

`src/server/rest/context.ts` mirrors `ensureUserMiddleware` + `requireProjectContext` for raw routes, reusing `resolveUserContextFromHeaders` — the resolver upstream explicitly documents as _"shared by ensureUserMiddleware (server functions) and raw API routes, which can't use function middleware."_ `projectId` is authorized through the org-scoped lookup, so an unknown or foreign id is a 404, never a leak.

### Examples

```sh
B=http://localhost:3001/api/rest
P=$(curl -s -X POST $B/projects/list -H 'content-type: application/json' \
     | sed -n 's/.*"id":"\([^"]*\)".*/\1/p')

curl -s -X POST $B/domain/overview -H 'content-type: application/json' \
  -d "{\"projectId\":\"$P\",\"domain\":\"arena.im\"}"

curl -s -X POST $B/backlinks/overview -H 'content-type: application/json' \
  -d "{\"projectId\":\"$P\",\"target\":\"arena.im\",\"scope\":\"domain\"}"

A=$(curl -s -X POST $B/audits/start -H 'content-type: application/json' \
  -d "{\"projectId\":\"$P\",\"startUrl\":\"https://arena.im\",\"maxPages\":10,\"lighthouseStrategy\":\"none\"}" \
  | sed -n 's/.*"auditId":"\([^"]*\)".*/\1/p')

# startAudit is async: poll until the status leaves "running".
while :; do
  STATUS=$(curl -s -X POST $B/audits/status -H 'content-type: application/json' \
    -d "{\"projectId\":\"$P\",\"auditId\":\"$A\"}" \
    | sed -n 's/.*"status":"\([^"]*\)".*/\1/p')
  [ "$STATUS" = "running" ] || break
  sleep 2
done

# Only "completed" has results; "failed" carries errorCode/errorDetail instead.
if [ "$STATUS" = "completed" ]; then
  curl -s -X POST $B/audits/results -H 'content-type: application/json' \
    -d "{\"projectId\":\"$P\",\"auditId\":\"$A\"}"
else
  echo "audit did not complete: $STATUS"
fi
```

---

## MCP: the capability that already existed

Before writing any REST code, note that **OpenSEO already ships an MCP server** exposing these same analyses over HTTP with API-key auth (`src/server/mcp/`). For agent-driven use (Claude Code, etc.) it is strictly better than the REST layer — richer descriptions, output schemas, and cost hints already written.

Route `/mcp`. Auth via `src/server/mcp/api-key-auth.ts` (API keys) or the OAuth provider for hosted mode.

Relevant tools (`src/server/mcp/tools/`):

| Tool                                                                          | Internal function                    |
| ----------------------------------------------------------------------------- | ------------------------------------ |
| `get_domain_overview`                                                         | `DomainService.getOverview`          |
| `get_domain_keyword_suggestions`                                              | `DomainService.getSuggestedKeywords` |
| `get_backlinks_overview`                                                      | `BacklinksService` overview          |
| `get_backlinks_profile`                                                       | `BacklinksService` profile           |
| `run_site_audit` / `get_audit_status` / `get_audit_issues`                    | `AuditService` start/status/results  |
| `research_keywords`, `get_serp_results`, `create_project`, `list_projects`, … | keyword & project services           |

All MCP tools go through `withMcpProjectAuth`, which authorizes `projectId` against the token's organization and builds the billing context — the same shape the REST layer reproduces.

Setup: in-app **AI & MCP** page, or `https://openseo.so/docs/mcp`.

> [!TIP] Why REST exists anyway
> Arena's services (NestJS / Lambda) speak plain HTTP, not MCP transports, and WID-2805 needs a stable contract boundary it can version independently of upstream. MCP remains the better door for agents.

---

## Verification status

| Check                                 | Result                                                       |
| ------------------------------------- | ------------------------------------------------------------ |
| Fork under Arena org                  | ✅ `stationfy/open-seo`, public, parent `every-app/open-seo` |
| Postgres backend                      | ✅ 31 tables migrated; app rows confirmed in PG              |
| Auth disabled                         | ✅ `authMode: local_noauth`, browser loads with no sign-in   |
| Three analyses triggered from browser | ✅ real DataForSEO data for `arena.im`                       |
| TanStack → internal fn mapping        | ✅ decoded from the `_serverFn` segment                      |
| REST endpoints                        | ✅ all 10 return payloads identical to the browser           |
| Auth gate                             | ✅ 403 on every route under `cloudflare_access`              |
| Completion semantics                  | ✅ observed `running → completed` in Postgres                |
| `pnpm lint` / `types:check` / `test`  | ✅ 0 errors · 0 errors · 1006 passed                         |
