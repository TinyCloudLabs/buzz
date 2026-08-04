import { createFileRoute } from "@tanstack/react-router";
import { KeysPage } from "@/features/keys/ui/KeysPage";

export const Route = createFileRoute("/keys")({
  component: KeysPage,
});
