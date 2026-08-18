import { createFileRoute } from "@tanstack/react-router";
import { DomainService } from "@/server/features/domain/services/DomainService";
import { withProjectRoute } from "@/server/rest/context";
import { resolveLabsMarket } from "@/shared/keyword-locations";
import { domainOverviewSchema } from "@/types/schemas/domain";

export const Route = createFileRoute("/api/rest/domain/overview")({
  server: {
    handlers: {
      POST: withProjectRoute(domainOverviewSchema, (data, context) =>
        DomainService.getOverview(
          {
            ...data,
            ...resolveLabsMarket(data, context.project),
            projectId: context.projectId,
          },
          context,
        ),
      ),
    },
  },
});
