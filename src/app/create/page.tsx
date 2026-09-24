import { redirect } from "next/navigation";

/**
 * The permissionless launch flow is retired, not deleted — `create-form.tsx`
 * and every contract it calls (AromaFactory, CurveManager, PoolFactory) are
 * untouched, in case this ever comes back. Launching is gated by the Club
 * auction now; this route just points there instead of rendering the old
 * form, so restoring the old flow later is deleting this one redirect.
 */
export default function CreatePage() {
  redirect("/club");
}
