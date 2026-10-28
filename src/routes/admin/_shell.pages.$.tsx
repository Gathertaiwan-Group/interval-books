/**
 * /admin/pages/* —— 只剩轉址，回 /admin。說明見 src/routes/admin/_shell.pages.tsx。
 */
import { createFileRoute, redirect } from "@tanstack/react-router";

export const Route = createFileRoute("/admin/_shell/pages/$")({
  beforeLoad: () => {
    throw redirect({ to: "/admin", replace: true });
  },
});
