/**
 * /news/* —— 只剩轉址，回首頁。說明見 src/routes/news.tsx。
 */
import { createFileRoute, redirect } from "@tanstack/react-router";

export const Route = createFileRoute("/news/$")({
  beforeLoad: () => {
    throw redirect({ to: "/", statusCode: 301 });
  },
});
