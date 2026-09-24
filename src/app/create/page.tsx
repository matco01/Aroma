import { redirect } from "next/navigation";

/**
 * The permissionless launch flow is retired, not deleted. `create-form.tsx`
 * — wired to the Arc pool system (PoolFactory) — and every contract it
 * calls are untouched, in case it ever comes back. Launching is gated by the
 * Club auction now; this route points there instead of rendering the old
 * form, so restoring the old flow later means restoring this file's previous
 * version, nothing else.
 */
export default function CreatePage() {
  redirect("/club");
}
