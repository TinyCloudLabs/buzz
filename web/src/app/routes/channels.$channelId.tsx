import { createFileRoute } from "@tanstack/react-router";
import { ChannelComposer } from "@/features/channel/ui/ChannelComposer";

export const Route = createFileRoute("/channels/$channelId")({
  component: ChannelRoute,
});

function ChannelRoute() {
  const { channelId } = Route.useParams();
  return <ChannelComposer channelId={channelId} />;
}
