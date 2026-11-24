import type { AdminProductListResponse } from '@repo/shared';
import { EyeOff, Eye } from 'lucide-react';
import { useTranslations } from 'use-intl';
import { listAudit } from '../../lib/api/people';
import { updateProduct } from '../../lib/api/writes-catalog';
import { actionParts } from '../../lib/idempotency';
import { findActionAudit } from '../../lib/idempotency-outcome';
import { ReasonDialog } from '../common/ReasonDialog';
import { useAdminAction } from '../common/use-admin-action';

type Product = AdminProductListResponse[number];

/**
 * The switch has its own registry entry (CR A2): the editor writes the same
 * `catalog.productUpdate` on the same product with another body, so an unknown outcome of one
 * must not hand its key and reason to the other.
 */
export const activeTargetOf = (productId: string) => `${productId}-active`;

interface Props {
  product: Product;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

/**
 * The list's on/off switch (AdminOps.dc.html `products` row switch): `isActive` only, after a
 * reason. Switching off hides the product from the store; open orders are not touched.
 */
export function ProductActiveDialog({ product, open, onOpenChange }: Props) {
  const t = useTranslations();
  const act = useAdminAction();
  const next = !product.isActive;
  const look = next ? 'on' : 'off';
  const action = act.idOf('catalog.productUpdate', activeTargetOf(product.id));
  const { adminId } = actionParts(action);
  return (
    <ReasonDialog
      action={action}
      open={open}
      onOpenChange={onOpenChange}
      title={t(`admin.catalog.toggle.${look}.title`)}
      description={t(`admin.catalog.toggle.${look}.body`, { name: product.nameUz })}
      icon={next ? Eye : EyeOff}
      tone={next ? 'primary' : 'danger'}
      submitLabel={t(`admin.catalog.toggle.${look}.cta`)}
      actor={act.actor}
      fields={{ isActive: next }}
      // The audit row names the product itself, not the registry's `-active` target.
      lookupOutcome={async (auditId) =>
        (await findActionAudit({ adminId, targetId: product.id, auditId }, (query) =>
          listAudit(query),
        )) === 'found'
      }
      onOutcomeFound={() => act.found('catalog.productUpdate')}
      onSubmit={async ({ reason, idempotencyKey }) => {
        const result = await updateProduct(product.id, { isActive: next, reason }, idempotencyKey);
        act.finished('catalog.productUpdate', result);
      }}
    />
  );
}
