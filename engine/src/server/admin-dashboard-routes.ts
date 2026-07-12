// Admin dashboard reporting routes — usage/feedback/semantic-search/
// issue-tracking, all mounted under /api/admin/* alongside admin-routes.ts.
// Port of v1's app/admin.py "Usage metrics" / "Issue progress tracking" /
// "Semantic search recall log" sections (git show v1-python-final:
// app/admin.py). Kept in its own file rather than folded into
// admin-routes.ts: that file is identity/resource CRUD (users/repos/
// permissions); everything here is read-only reporting plus one manual
// poll trigger — a different responsibility, not more of the same one.
import type { Hono, Context } from "hono";
import type { DbClient } from "../db/client.js";
import type { Settings } from "../config.js";
import type { Env } from "./app.js";
import { pollTrackedIssues, computeTrackingMetrics } from "../issue-tracker.js";

export type AdminDashboardRoutesDeps = { db: DbClient; settings: Settings };

function parseLimit(c: Context<Env>, defaultValue: number): number {
  const raw = c.req.query("limit");
  if (raw === undefined) return defaultValue;
  const n = Number(raw);
  return Number.isFinite(n) ? n : defaultValue;
}

export function mountAdminDashboardRoutes(app: Hono<Env>, deps: AdminDashboardRoutesDeps): void {
  // ==================== Usage metrics ====================

  app.get("/api/admin/usage/summary", async (c) => c.json(await deps.db.getUsageSummary()));

  app.get("/api/admin/usage/by-user", async (c) => c.json(await deps.db.getUsageByUser()));

  app.get("/api/admin/usage/recent", async (c) =>
    c.json(await deps.db.getRecentLlmCalls(parseLimit(c, 50))),
  );

  app.get("/api/admin/feedback/summary", async (c) => {
    const summary = await deps.db.getFeedbackSummary();
    const recentNegative = await deps.db.getRecentNegativeFeedback(20);
    return c.json({ ...summary, recent_negative: recentNegative });
  });

  // ==================== Issue progress tracking ====================

  app.get("/api/admin/issues/tracking", async (c) => {
    const overview = await deps.db.getIssueTrackingOverview(parseLimit(c, 100));
    // Metrics need the issue bodies (path-reference extraction); the
    // client doesn't — strip them after computing rather than shipping
    // N×KB of markdown to the browser per refresh.
    const metrics = computeTrackingMetrics(overview.submissions);
    const submissions = overview.submissions.map(({ body: _body, ...rest }) => rest);
    return c.json({ counts: overview.counts, submissions, metrics });
  });

  app.post("/api/admin/issues/tracking/poll", async (c) => {
    // Manual refresh — same reconciliation the background loop runs.
    const polled = await pollTrackedIssues(deps.db, deps.settings);
    return c.json({ ok: true, polled });
  });

  // ==================== Semantic search recall log ====================

  app.get("/api/admin/semantic-search/summary", async (c) =>
    c.json(await deps.db.getSemanticSearchStats()),
  );

  app.get("/api/admin/semantic-search/recent", async (c) => {
    const lowScoreOnly = c.req.query("low_score_only") === "true";
    return c.json(await deps.db.getSemanticSearchRecent(parseLimit(c, 50), lowScoreOnly));
  });
}
