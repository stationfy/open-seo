import { createFileRoute } from "@tanstack/react-router";
import { ProjectService } from "@/server/features/projects/services/ProjectService";
import { withOrgReadRoute } from "@/server/rest/context";

// Creates a default project when the organization has none, so a caller can
// obtain a usable projectId without a separate bootstrap step.
export const Route = createFileRoute("/api/rest/projects/list")({
  server: {
    handlers: {
      POST: withOrgReadRoute((context) =>
        ProjectService.listProjectsEnsuringOne(context.organizationId),
      ),
    },
  },
});
