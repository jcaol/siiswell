import { describe, expect, test, afterEach } from "bun:test";
import { route } from "../src/index";
import { configureDashboardTz, dashboardTz } from "../src/tz";
import { sanitizeUsageBatch } from "../src/usage";
import { makeCtx, makeEnv, request } from "./d1-shim";

// a route() with DASHBOARD_TZ sets the process-wide zone: back to the default after each test
afterEach(() => {
  configureDashboardTz({}); // reset
});

const NOW = Date.UTC(2027, 6, 1, 23, 30); // 2 July 00:30 in London (BST), still 1 July in UTC

describe("DASHBOARD_TZ: the dashboard's own time zone (default UTC)", () => {
  test("unset or invalid -> UTC; a valid IANA name is used", () => {
    configureDashboardTz({});
    expect(dashboardTz()).toBe("UTC");
    configureDashboardTz({ DASHBOARD_TZ: "Not/AZone" });
    expect(dashboardTz()).toBe("UTC");
    configureDashboardTz({ DASHBOARD_TZ: "Europe/London" });
    expect(dashboardTz()).toBe("Europe/London");
    configureDashboardTz({});
  });

  test("the usage page's today, the well-being default zone and an upload without tz follow it", async () => {
    for (const [tz, day] of [[undefined, "2027-07-01"], ["Europe/London", "2027-07-02"]] as const) {
      const t = makeEnv(tz ? { DASHBOARD_TZ: tz } : {});
      const ctx = makeCtx();
      const u = (await (await route(request("/api/usage"), t.env, ctx, { now: NOW })).json()) as { today: string; tz: string };
      expect(u).toMatchObject({ today: day, tz: tz ?? "UTC" });
      const wb = (await (await route(request("/api/wellbeing"), t.env, ctx, { now: NOW })).json()) as { settings: { tz: string } };
      expect(wb.settings.tz).toBe(tz ?? "UTC");
      const b = sanitizeUsageBatch({ v: 1, host: "h", rows: [] }, NOW);
      expect(b.ok && b.value.tz).toBe(tz ?? "UTC");
    }
    configureDashboardTz({});
  });
});
