import { createFileRoute } from "@tanstack/react-router";
import { ProjectService } from "@/server/features/projects/services/ProjectService";
import { withOrgRoute } from "@/server/rest/context";
import { createProjectSchema } from "@/types/schemas/projects";

export const Route = createFileRoute("/api/rest/projects/create")({
  server: {
    handlers: {
      POST: withOrgRoute(createProjectSchema, (data, context) =>
        ProjectService.createProject(context.organizationId, data),
      ),
    },
  },
});
