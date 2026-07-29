import { createFileRoute } from "@tanstack/react-router";
import { DesignationsPage } from "@/components/hrm/structure-pages";

export const Route = createFileRoute("/_authenticated/hrm/designations")({
  head: () => ({ meta: [{ title: "Designations · ThesKwoff Hotel" }] }),
  component: DesignationsPage,
});
