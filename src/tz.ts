/**
 * @file The dashboard's own time zone (`DASHBOARD_TZ`, an IANA name; default UTC): the days of the usage page, the default
 * zone of usage uploads and OTLP data that name none, and the well-being layer's zone until the user picks one.
 * Set once per request / tick from the environment (it is the same for the whole deployment).
 */
let current = "UTC";

function valid(tz: unknown): tz is string {
  if (typeof tz !== "string" || !/^[A-Za-z0-9_/+-]{1,40}$/.test(tz)) return false;
  try {
    new Intl.DateTimeFormat("en-CA", { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

export function configureDashboardTz(env: { DASHBOARD_TZ?: string }): void {
  current = valid(env.DASHBOARD_TZ) ? env.DASHBOARD_TZ : "UTC";
}
export const dashboardTz = (): string => current;
