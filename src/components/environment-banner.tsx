import { ENVIRONMENT_LABEL } from "@/lib/deployment-identity";

/**
 * Staff-facing environment marker.
 *
 * Renders nothing at all unless the deployment declared an environment label
 * (APP_ENV_LABEL, or APP_ENV=demo). Production sets neither, so this returns
 * null there and adds no markup, no height and no layout of any kind.
 *
 * It is deliberately separate from tenant branding: the hotel's name, logo and
 * colours come from the database and describe *whose* data this is, while this
 * strip describes *which deployment* you are looking at. A demo property is
 * fully branded as itself; this is the one thing that says the data underneath
 * it is not real.
 *
 * Layout notes — this sits directly above the sticky app header inside the
 * min-w-0 content column, so it cannot widen the page: it is a block element
 * with no intrinsic minimum, and its text truncates rather than pushing the
 * column past the viewport. That matters because the top bar was only just
 * taught to shrink on phones (#91) and this must not reintroduce sideways
 * scrolling on a 320px screen.
 */
export function EnvironmentBanner() {
  if (!ENVIRONMENT_LABEL) return null;

  return (
    <div
      role="status"
      aria-live="off"
      className="flex w-full min-w-0 items-center gap-2 border-b border-amber-500/40 bg-amber-500/15 px-3 py-1 text-[11px] font-medium text-amber-900 dark:text-amber-200"
    >
      <span className="shrink-0 rounded-sm bg-amber-500/30 px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wider">
        {ENVIRONMENT_LABEL}
      </span>
      <span className="min-w-0 truncate">
        Demonstration environment — sample data only, not a live hotel.
      </span>
    </div>
  );
}
