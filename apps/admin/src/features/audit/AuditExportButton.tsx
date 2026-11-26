import { Button } from '@repo/ui';
import { Download } from 'lucide-react';
import { useState } from 'react';
import { useTranslations } from 'use-intl';
import { apiFetchText } from '../../lib/api/client';
import type { Query } from '../../lib/api/reads';

/**
 * CSV export of the audit log (OWNER, `audit.export`). A plain download link would get a 404: the
 * admin guard accepts an Origin-less GET only as the SPA's own same-origin fetch
 * (`Sec-Fetch-Site: same-origin`, mode `cors`/`same-origin`, dest `empty`, Host = ADMIN_URL host;
 * admin-csrf.guard.ts `sameOriginRead`), and a link click is a navigation (mode `navigate`, dest
 * `document`). So the file is fetched with credentials and saved from a Blob. The export itself
 * is audited by the API (AUDIT_EXPORT).
 */
export function AuditExportButton({ filters }: { filters: Query }) {
  const t = useTranslations();
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);
  async function exportCsv() {
    setBusy(true);
    setFailed(false);
    try {
      const csv = await apiFetchText({
        path: '/admin/audit-log/export.csv',
        query: filters,
        group: 'audit',
      });
      const url = URL.createObjectURL(new Blob([csv], { type: 'text/csv;charset=utf-8' }));
      const link = document.createElement('a');
      link.href = url;
      link.download = 'audit-log.csv';
      link.click();
      URL.revokeObjectURL(url);
    } catch {
      setFailed(true);
    } finally {
      setBusy(false);
    }
  }
  return (
    <span className="flex items-center gap-2">
      {failed ? (
        <span role="alert" className="text-xs leading-4 font-semibold text-danger-text">
          {t('admin.audit.exportFailed')}
        </span>
      ) : null}
      <Button
        variant="outline"
        size="sm"
        aria-busy={busy}
        disabled={busy}
        onClick={() => void exportCsv()}
      >
        <Download size={14} aria-hidden="true" />
        {t('admin.audit.export')}
      </Button>
    </span>
  );
}
