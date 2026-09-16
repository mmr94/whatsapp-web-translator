// Runtime self-checks shared by the page world (producer), the content script (relay),
// the service worker (badge) and the popup (display).

export const HEALTH_TAG = '__wttHealth';
export const HEALTH_KEY = 'health';

// idle: nothing to check right now (e.g. no chat open) — neither good nor bad.
export type HealthStatus = 'ok' | 'degraded' | 'down' | 'idle';

export interface HealthCheck {
  id: string;
  label: string;
  status: HealthStatus;
  detail: string;
}

export interface HealthReport {
  checkedAt: number;
  waVersion: string;
  checks: HealthCheck[];
}

// Checks keep their last conclusive (non-idle) result, so closing a chat doesn't hide a
// failure seen a moment ago.
export function mergeReports(previous: HealthReport | null, next: HealthReport): HealthReport {
  if (!previous) return next;
  const before = new Map(previous.checks.map((c) => [c.id, c]));
  return {
    ...next,
    checks: next.checks.map((check) => {
      const old = before.get(check.id);
      return check.status === 'idle' && old && old.status !== 'idle' ? { ...old } : check;
    }),
  };
}

export function worstStatus(report: HealthReport | null): HealthStatus {
  const statuses = report?.checks.map((c) => c.status) ?? [];
  if (statuses.includes('down')) return 'down';
  if (statuses.includes('degraded')) return 'degraded';
  return statuses.includes('ok') ? 'ok' : 'idle';
}

export function formatReport(report: HealthReport | null, extra: string[] = []): string {
  if (!report) return 'Aucun diagnostic : ouvrez WhatsApp Web.';
  return [
    `Diagnostic WhatsApp Web Translator — ${new Date(report.checkedAt).toISOString()}`,
    `WhatsApp Web ${report.waVersion || 'version inconnue'}`,
    ...extra,
    ...report.checks.map((c) => `[${c.status}] ${c.label} — ${c.detail}`),
  ].join('\n');
}
