import { env, waitUntil } from "cloudflare:workers";
import { z } from "zod";
import { getAuthMode } from "@/lib/auth-mode";
import { resolveUserContextFromHeaders } from "@/middleware/ensure-user/resolve";
import type {
  EnsuredProject,
  EnsuredUserContext,
} from "@/middleware/ensure-user/types";
import { ProjectRepository } from "@/server/features/projects/repositories/ProjectRepository";
import { AppError, asAppError } from "@/server/lib/errors";
import { captureServerError } from "@/server/lib/posthog";
import {
  shouldCaptureAppErrorCode,
  type ErrorCode,
} from "@/shared/error-codes";

type RestProjectContext = EnsuredUserContext & {
  project: EnsuredProject;
  projectId: string;
};

const HTTP_STATUS_BY_ERROR_CODE: Record<ErrorCode, number> = {
  UNAUTHENTICATED: 401,
  AUTH_CONFIG_MISSING: 500,
  PAYMENT_REQUIRED: 402,
  INSUFFICIENT_CREDITS: 402,
  FORBIDDEN: 403,
  NOT_FOUND: 404,
  AUDIT_CAPACITY_REACHED: 409,
  AUDIT_PAGE_LIMIT_EXCEEDED: 409,
  AUDIT_ALREADY_RUNNING: 409,
  VALIDATION_ERROR: 400,
  CRAWL_TARGET_BLOCKED: 422,
  BACKLINKS_BILLING_ISSUE: 402,
  AI_SEARCH_BILLING_ISSUE: 402,
  DATAFORSEO_AUTH_FAILED: 502,
  RATE_LIMITED: 429,
  UPSTREAM_UNAVAILABLE: 502,
  CONFLICT: 409,
  INTERNAL_ERROR: 500,
};

// Codes whose message is always author-written guidance rather than anything
// echoed back from an upstream provider. Mirrors the intent of toClientError:
// everything else is stripped to its bare code, because assertOk builds
// AppError("INTERNAL_ERROR", <DataForSEO status_message>) and that text must
// not reach a caller.
const CLIENT_DETAIL_ERROR_CODES = new Set<ErrorCode>([
  "VALIDATION_ERROR",
  "FORBIDDEN",
  "AUTH_CONFIG_MISSING",
]);

const projectScopedSchema = z.object({ projectId: z.string().min(1) });

/**
 * Fails closed unless the instance runs in `local_noauth`.
 *
 * These routes carry no credentials by design (WID-2962), so the only thing
 * standing between them and an open, credit-spending SEO API is the auth mode.
 * Gating here rather than at the edge means a deploy that flips AUTH_MODE to
 * `hosted` or `cloudflare_access` disables the whole surface automatically
 * instead of silently exposing it.
 */
function assertRestApiEnabled(): void {
  if (getAuthMode(env.AUTH_MODE) !== "local_noauth") {
    throw new AppError(
      "FORBIDDEN",
      "The unauthenticated REST API is only available when AUTH_MODE=local_noauth.",
    );
  }
}

/**
 * Rejects requests that aren't declared JSON.
 *
 * Without this, `request.json()` happily parses a `text/plain` body, which
 * makes every one of these state-changing POSTs a CORS-*simple* request: a page
 * the operator happens to be visiting could fire one at localhost with no
 * preflight and land a blind write. Requiring `application/json` forces a
 * preflight that fails, since these routes send no CORS headers.
 */
function assertJsonContentType(request: Request): void {
  const contentType = request.headers.get("content-type") ?? "";
  if (!contentType.toLowerCase().includes("application/json")) {
    throw new AppError(
      "VALIDATION_ERROR",
      "Content-Type must be application/json.",
    );
  }
}

/** Runs both request-level gates in the order every route depends on. */
function assertRestRequest(request: Request): void {
  assertRestApiEnabled();
  assertJsonContentType(request);
}

/**
 * Resolves the caller's identity for a raw API route.
 *
 * Reuses the same resolver the TanStack server functions run through, so the
 * `local-admin` user and its organization are bootstrapped identically no
 * matter which surface a request arrives on.
 */
function resolveRestContext(request: Request): Promise<EnsuredUserContext> {
  return resolveUserContextFromHeaders(request.headers);
}

/**
 * Resolves identity and authorizes `projectId` against the caller's org.
 *
 * Mirrors `ensureUserMiddleware` + `requireProjectContext`: the project row is
 * fetched through the org-scoped lookup so an unknown or foreign id is a 404,
 * never a leak, and the resulting shape is what the services expect as their
 * billing/context argument.
 */
async function resolveRestProjectContext(
  request: Request,
  projectId: string,
): Promise<RestProjectContext> {
  const context = await resolveRestContext(request);
  const project = await ProjectRepository.getProjectForOrganization(
    projectId,
    context.organizationId,
  );

  if (!project) {
    throw new AppError("NOT_FOUND");
  }

  return { ...context, project, projectId: project.id };
}

/** Parses a JSON request body, surfacing malformed input as VALIDATION_ERROR. */
async function readJsonBody(request: Request): Promise<unknown> {
  try {
    return await request.json();
  } catch {
    throw new AppError("VALIDATION_ERROR", "Request body must be valid JSON.");
  }
}

/**
 * Validates a body against `schema`, reporting field paths on failure.
 *
 * The services already validate their own inputs, but doing it at the boundary
 * turns a 500 from deep inside a service into an actionable 400 for the caller.
 */
function parseBody<TSchema extends z.ZodType>(
  schema: TSchema,
  body: unknown,
): z.infer<TSchema> {
  const result = schema.safeParse(body);
  if (!result.success) {
    throw new AppError(
      "VALIDATION_ERROR",
      result.error.issues
        .map((issue) => `${issue.path.join(".") || "body"}: ${issue.message}`)
        .join("; "),
    );
  }
  return result.data;
}

/**
 * Converts a thrown error into its HTTP status and a stable JSON body.
 *
 * Reportable faults are logged and captured here the way
 * `errorHandlingMiddleware` does for server functions — without this, the same
 * DataForSEO failure is observable through the UI but silent through REST.
 */
async function handleRest(
  request: Request,
  run: () => Promise<unknown>,
): Promise<Response> {
  try {
    return Response.json({ data: await run() });
  } catch (error) {
    const appError = asAppError(error);
    const code: ErrorCode = appError?.code ?? "INTERNAL_ERROR";

    if (shouldCaptureAppErrorCode(appError?.code)) {
      const url = new URL(request.url);
      console.error("rest.api error:", error);
      waitUntil(
        captureServerError(error, {
          errorCode: code,
          method: request.method,
          path: url.pathname,
          ...appError?.details,
        }),
      );
    }

    const message =
      appError &&
      CLIENT_DETAIL_ERROR_CODES.has(appError.code) &&
      appError.message !== appError.code
        ? appError.message
        : undefined;

    return Response.json(
      { error: { code, ...(message ? { message } : {}) } },
      { status: HTTP_STATUS_BY_ERROR_CODE[code] },
    );
  }
}

/**
 * Runs a handler that needs an authorized project, resolved from the body.
 *
 * Every exposed analysis is project-scoped and takes `projectId` in its input,
 * so this reads it once, authorizes it, and hands the handler both the parsed
 * body and the context the services expect.
 */
export function withProjectRoute<TSchema extends z.ZodType>(
  schema: TSchema,
  handler: (
    data: z.infer<TSchema>,
    context: RestProjectContext,
  ) => Promise<unknown>,
) {
  return ({ request }: { request: Request }): Promise<Response> =>
    handleRest(request, async () => {
      assertRestRequest(request);
      const body = await readJsonBody(request);
      const { projectId } = parseBody(projectScopedSchema, body);
      const context = await resolveRestProjectContext(request, projectId);
      return handler(parseBody(schema, body), context);
    });
}

/** Runs an org-scoped handler that takes a validated JSON body. */
export function withOrgRoute<TSchema extends z.ZodType>(
  schema: TSchema,
  handler: (
    data: z.infer<TSchema>,
    context: EnsuredUserContext,
  ) => Promise<unknown>,
) {
  return ({ request }: { request: Request }): Promise<Response> =>
    handleRest(request, async () => {
      assertRestRequest(request);
      const body = parseBody(schema, await readJsonBody(request));
      return handler(body, await resolveRestContext(request));
    });
}

/**
 * Runs an org-scoped handler that takes no body.
 *
 * Still requires the JSON content type: `listProjectsEnsuringOne` creates a
 * project when the org has none, so even the "read" routes can write.
 */
export function withOrgReadRoute(
  handler: (context: EnsuredUserContext) => Promise<unknown>,
) {
  return ({ request }: { request: Request }): Promise<Response> =>
    handleRest(request, async () => {
      assertRestRequest(request);
      return handler(await resolveRestContext(request));
    });
}
