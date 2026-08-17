import { createFileRoute } from "@tanstack/react-router";
import { AuditService } from "@/server/features/audit/services/AuditService";
import { withProjectRoute } from "@/server/rest/context";
import { getCrawlProgressSchema } from "@/types/schemas/audit";

export const Route = createFileRoute("/api/rest/audits/crawl-progress")({
  server: {
    handlers: {
      POST: withProjectRoute(getCrawlProgressSchema, (data, context) =>
        AuditService.getCrawlProgress(data.auditId, context.projectId),
      ),
    },
  },
});
