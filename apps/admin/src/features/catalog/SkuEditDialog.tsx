import type { AdminProductDetailResponse } from '@repo/shared';
import { PackagePlus, Pencil, TriangleAlert } from 'lucide-react';
import { useState, type ComponentProps } from 'react';
import { useTranslations } from 'use-intl';
import { NotSentError } from '../../lib/api/errors';
import { createSku, updateSku } from '../../lib/api/writes-catalog';
import { pendingFields, type ActionFields } from '../../lib/idempotency';
import { useDebounced } from '../../lib/use-debounced';
import { CheckField } from '../common/CheckField';
import { ReasonDialog } from '../common/ReasonDialog';
import { useAdminAction } from '../common/use-admin-action';
import { FormField } from './FormField';
import { PricePreview } from './PricePreview';
import {
  emptySkuDraft,
  minMarginToTiyin,
  percentToBps,
  skuCreateBody,
  skuDraftOf,
  skuIssues,
  skuUpdateChange,
  type SkuDraft,
  type SkuField,
} from './sku-form-model';

type Sku = AdminProductDetailResponse['skus'][number];
type FieldExtra = Pick<ComponentProps<typeof FormField>, 'hint' | 'code' | 'inputMode' | 'suffix'>;

interface Props {
  product: AdminProductDetailResponse;
  /** The package to edit; null adds a new one. */
  sku: Sku | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

export function SkuEditDialog(props: Props) {
  return props.open ? <SkuEditOpen {...props} /> : null;
}

/** After an unknown outcome the fields come back as they were sent (memory only). */
function refill(sent: ActionFields | null, draft: SkuDraft): SkuDraft {
  if (sent === null) return draft;
  const text = (key: keyof SkuDraft) => {
    const value = sent[key];
    return typeof value === 'string' ? value : String(draft[key]);
  };
  return {
    tab: text('tab'),
    labelUz: text('labelUz'),
    labelRu: text('labelRu'),
    quantity: text('quantity'),
    supplierSku: text('supplierSku'),
    markup: text('markup'),
    minMargin: text('minMargin'),
    isActive: typeof sent.isActive === 'boolean' ? sent.isActive : draft.isActive,
    sort: text('sort'),
  };
}

/**
 * A new package or an edit of one (plan S8b; no frame in the handoff: built in the style of the
 * other action dialogs). The markup is typed in percent and sent as whole basis points, the
 * minimum margin in so'm and sent as tiyin; an edit sends only the changed fields. While editing,
 * the price is previewed live with the typed markup and margin (300 ms after the last key).
 */
function SkuEditOpen({ product, sku, onOpenChange }: Props) {
  const t = useTranslations();
  const act = useAdminAction();
  const kind = sku === null ? 'catalog.skuCreate' : 'catalog.skuUpdate';
  const action = act.idOf(kind, sku === null ? product.id : sku.id);
  const [draft, setDraft] = useState(() =>
    refill(
      pendingFields(action),
      sku === null ? emptySkuDraft(product.skus.length) : skuDraftOf(sku),
    ),
  );
  const set = (field: SkuField) => (value: string) => setDraft({ ...draft, [field]: value });
  const issues = skuIssues(draft);
  const change = sku === null ? null : skuUpdateChange(sku, draft);
  const createBody = sku === null ? skuCreateBody(draft) : null;
  const valid = sku === null ? createBody !== null : change?.body != null;
  const markupBps = useDebounced(percentToBps(draft.markup), 300);
  const minMarginTiyin = useDebounced(minMarginToTiyin(draft.minMargin), 300);
  // A field says what is wrong only after the admin has left it (CR A5): a new package opens
  // with empty fields, not with a dialog full of errors.
  const [touched, setTouched] = useState<ReadonlySet<SkuField>>(() => new Set());
  const issueText = (name: SkuField) => {
    const issue = issues[name];
    return issue === undefined || !touched.has(name) ? null : t(`admin.catalog.form.${issue}`);
  };
  const field = (name: SkuField, label: string, extra: FieldExtra = {}) => (
    <FormField
      label={label}
      value={draft[name]}
      onChange={set(name)}
      onBlur={() => setTouched(new Set(touched).add(name))}
      error={issueText(name)}
      {...extra}
    />
  );
  const look = sku === null ? 'create' : 'edit';
  return (
    <ReasonDialog
      action={action}
      open
      onOpenChange={onOpenChange}
      title={t(`admin.catalog.sku.dialog.${look}.title`)}
      description={t(`admin.catalog.sku.dialog.${look}.body`, {
        product: product.nameUz,
        label: sku?.labelUz ?? '',
      })}
      icon={sku === null ? PackagePlus : Pencil}
      submitLabel={t(`admin.catalog.sku.dialog.${look}.cta`)}
      actor={act.actor}
      extraValid={valid}
      fields={{ ...draft }}
      onOutcomeFound={() => act.found(kind)}
      onSubmit={async ({ reason, idempotencyKey }) => {
        if (sku === null) {
          if (createBody === null) throw new NotSentError();
          act.finished(
            kind,
            await createSku(product.id, { ...createBody, reason }, idempotencyKey),
          );
          return;
        }
        if (change?.body == null) throw new NotSentError();
        act.finished(kind, await updateSku(sku.id, { ...change.body, reason }, idempotencyKey));
      }}
    >
      <div className="grid grid-cols-1 gap-2.5 sm:grid-cols-2">
        {field('labelUz', t('admin.catalog.sku.labelUz'))}
        {field('labelRu', t('admin.catalog.sku.labelRu'))}
        {field('quantity', t('admin.catalog.sku.quantity'), { inputMode: 'numeric', code: true })}
        {field('sort', t('admin.catalog.sku.sort'), { inputMode: 'numeric', code: true })}
        {field('supplierSku', t('admin.catalog.sku.supplier'), { code: true })}
        {field('tab', t('admin.catalog.sku.tab'), { hint: t('admin.catalog.sku.tabHint') })}
        {field('markup', t('admin.catalog.sku.markup'), {
          hint: t('admin.catalog.sku.markupHint'),
          inputMode: 'decimal',
          suffix: '%',
          code: true,
        })}
        {field('minMargin', t('admin.catalog.sku.minMargin'), {
          hint: t('admin.catalog.sku.minMarginHint'),
          inputMode: 'decimal',
          suffix: t('admin.dialogs.amount.som'),
          code: true,
        })}
      </div>
      <CheckField
        label={t('admin.catalog.sku.active')}
        checked={draft.isActive}
        onChange={(isActive) => setDraft({ ...draft, isActive })}
      />
      {change?.quantityChanged ? (
        <p
          role="alert"
          className="m-0 flex items-start gap-2 rounded-sm bg-warning-soft px-3 py-2.5 text-xs leading-4 font-bold text-warning-text"
        >
          <TriangleAlert size={15} aria-hidden="true" className="mt-px flex-none" />
          {t('admin.catalog.sku.quantityWarn')}
        </p>
      ) : null}
      {change?.empty ? (
        <p className="m-0 text-[11px] leading-[15px] font-semibold text-foreground-muted">
          {t('admin.catalog.form.noChanges')}
        </p>
      ) : null}
      {/* A new quantity has no cost yet (the warning above): the old price would mislead (CR A4). */}
      {sku === null || change?.quantityChanged ? null : (
        <PricePreview
          productId={product.id}
          skuId={sku.id}
          draft={
            markupBps === null || minMarginTiyin === null ? null : { markupBps, minMarginTiyin }
          }
        />
      )}
    </ReasonDialog>
  );
}
