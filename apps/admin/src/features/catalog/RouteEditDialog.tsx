import type { AdminProductDetailResponse, AdminRouteUpdateBody } from '@repo/shared';
import { Route as RouteIcon } from 'lucide-react';
import { useState } from 'react';
import { useTranslations } from 'use-intl';
import { NotSentError } from '../../lib/api/errors';
import { updateRoute } from '../../lib/api/writes-catalog';
import { pendingFields } from '../../lib/idempotency';
import { CheckField } from '../common/CheckField';
import { ReasonDialog } from '../common/ReasonDialog';
import { useAdminAction } from '../common/use-admin-action';
import { FormField } from './FormField';

type Route = AdminProductDetailResponse['routes'][number];

interface Props {
  product: AdminProductDetailResponse;
  route: Route;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

/** 0..1000 as typed (digits only), or null. */
export function priorityOf(raw: string): number | null {
  const text = raw.trim();
  if (!/^\d{1,4}$/.test(text)) return null;
  const value = Number.parseInt(text, 10);
  return value <= 1000 ? value : null;
}

/** Only what changed (docs/04 `PATCH /admin/routes/:id`); null when nothing did or it is invalid. */
export function routeChange(
  route: Route,
  draft: { priority: string; isEnabled: boolean },
): AdminRouteUpdateBody | null {
  const priority = priorityOf(draft.priority);
  if (priority === null) return null;
  const body = {
    ...(priority === route.priority ? {} : { priority }),
    ...(draft.isEnabled === route.isEnabled ? {} : { isEnabled: draft.isEnabled }),
  };
  return Object.keys(body).length === 0 ? null : body;
}

export function RouteEditDialog(props: Props) {
  return props.open ? <RouteEditOpen {...props} /> : null;
}

/**
 * A delivery route's priority and on/off (AdminOps.dc.html «Routing»: the design's "up" arrow is
 * a priority number here, since one write changes one route).
 */
function RouteEditOpen({ product, route, onOpenChange }: Props) {
  const t = useTranslations();
  const act = useAdminAction();
  const action = act.idOf('catalog.routeUpdate', route.id);
  const [sent] = useState(() => pendingFields(action));
  const [priority, setPriority] = useState(
    typeof sent?.priority === 'string' ? sent.priority : String(route.priority),
  );
  const [isEnabled, setEnabled] = useState(
    typeof sent?.isEnabled === 'boolean' ? sent.isEnabled : route.isEnabled,
  );
  const body = routeChange(route, { priority, isEnabled });
  const badPriority = priorityOf(priority) === null;
  return (
    <ReasonDialog
      action={action}
      open
      onOpenChange={onOpenChange}
      title={t('admin.catalog.route.dialog.title')}
      description={t('admin.catalog.route.dialog.body', {
        adapter: route.adapter,
        product: product.nameUz,
      })}
      icon={RouteIcon}
      submitLabel={t('admin.catalog.route.dialog.cta')}
      actor={act.actor}
      extraValid={body !== null}
      fields={{ priority, isEnabled }}
      onOutcomeFound={(applied) => act.found('catalog.routeUpdate', applied)}
      onSubmit={async ({ reason, idempotencyKey }) => {
        if (body === null) throw new NotSentError();
        const result = await updateRoute(route.id, { ...body, reason }, idempotencyKey);
        act.finished('catalog.routeUpdate', result);
      }}
    >
      <FormField
        label={t('admin.catalog.route.priority')}
        value={priority}
        onChange={setPriority}
        hint={t('admin.catalog.route.priorityHint')}
        error={badPriority ? t('admin.catalog.form.invalid') : null}
        inputMode="numeric"
        code
      />
      <CheckField
        label={t('admin.catalog.route.enabled')}
        checked={isEnabled}
        onChange={setEnabled}
      />
      {body === null && !badPriority ? (
        <p className="m-0 text-[11px] leading-[15px] font-semibold text-foreground-muted">
          {t('admin.catalog.form.noChanges')}
        </p>
      ) : null}
    </ReasonDialog>
  );
}
