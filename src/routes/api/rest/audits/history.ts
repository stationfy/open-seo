import { createFileRoute } from "@tanstack/react-router";
import { AuditService } from "@/server/features/audit/services/AuditService";
import { withProjectRoute } from "@/server/rest/context";
import { getAuditHistorySchema } from "@/types/schemas/audit";

export const Route = createFileRoute("/api/rest/audits/history")({
  server: {
    handlers: {
      POST: withProjectRoute(getAuditHistorySchema, (_data, context) =>
        AuditService.getHistory(context.projectId),
      ),
    },
  },
});
