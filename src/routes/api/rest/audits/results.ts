import { createFileRoute } from "@tanstack/react-router";
import { AuditService } from "@/server/features/audit/services/AuditService";
import { withProjectRoute } from "@/server/rest/context";
import { getAuditResultsSchema } from "@/types/schemas/audit";

export const Route = createFileRoute("/api/rest/audits/results")({
  server: {
    handlers: {
      POST: withProjectRoute(getAuditResultsSchema, (data, context) =>
        AuditService.getResults(data.auditId, context.projectId),
      ),
    },
  },
});
