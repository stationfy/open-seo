import { createFileRoute } from "@tanstack/react-router";
import { AuditService } from "@/server/features/audit/services/AuditService";
import { withProjectRoute } from "@/server/rest/context";
import { getAuditStatusSchema } from "@/types/schemas/audit";

// Prefer this over reading the `audits` row directly: getStatus also reconciles
// an audit whose workflow instance died without marking itself failed, so a
// zombie row resolves here instead of polling "running" until the cron watchdog
// sweeps it up to 15 minutes later.
export const Route = createFileRoute("/api/rest/audits/status")({
  server: {
    handlers: {
      POST: withProjectRoute(getAuditStatusSchema, (data, context) =>
        AuditService.getStatus(data.auditId, context.projectId),
      ),
    },
  },
});
