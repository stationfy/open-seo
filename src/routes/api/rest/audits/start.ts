import { createFileRoute } from "@tanstack/react-router";
import { waitUntil } from "cloudflare:workers";
import { AuditService } from "@/server/features/audit/services/AuditService";
import { captureServerEvent } from "@/server/lib/posthog";
import { withProjectRoute } from "@/server/rest/context";
import { startAuditSchema } from "@/types/schemas/audit";

// Returns only `{ auditId }`: the crawl runs in the SITE_AUDIT_WORKFLOW
// instance, so results are not persisted when this responds. Poll
// /api/rest/audits/status until status leaves "running", then read
// /api/rest/audits/results.
export const Route = createFileRoute("/api/rest/audits/start")({
  server: {
    handlers: {
      POST: withProjectRoute(startAuditSchema, async (data, context) => {
        const limitTier = await AuditService.resolveAuditLimitTier(
          context.organizationId,
        );

        const result = await AuditService.startAudit({
          actorUserId: context.userId,
          billingCustomer: context,
          projectId: context.projectId,
          startUrl: data.startUrl,
          maxPages: data.maxPages,
          lighthouseStrategy: data.lighthouseStrategy,
          limitTier,
        });

        // Mirrors the startAudit server function so audits started over REST
        // don't silently drop out of site_audit:start analytics.
        waitUntil(
          captureServerEvent({
            distinctId: context.userId,
            event: "site_audit:start",
            organizationId: context.organizationId,
            properties: {
              project_id: context.projectId,
              max_pages: data.maxPages,
              run_lighthouse: data.lighthouseStrategy !== "none",
              plan_tier: limitTier,
            },
          }),
        );

        return result;
      }),
    },
  },
});
