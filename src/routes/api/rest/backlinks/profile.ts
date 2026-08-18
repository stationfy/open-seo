import { createFileRoute } from "@tanstack/react-router";
import { BacklinksService } from "@/server/features/backlinks/services/BacklinksService";
import { withProjectRoute } from "@/server/rest/context";
import { backlinksOverviewInputSchema } from "@/types/schemas/backlinks";

export const Route = createFileRoute("/api/rest/backlinks/profile")({
  server: {
    handlers: {
      POST: withProjectRoute(backlinksOverviewInputSchema, (data, context) =>
        BacklinksService.profileOverview(
          { target: data.target, scope: data.scope },
          context,
        ),
      ),
    },
  },
});
