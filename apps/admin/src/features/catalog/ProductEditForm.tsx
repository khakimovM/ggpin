import type { AdminProductDetailResponse } from '@repo/shared';
import { Button, FOCUS_RING, Icon, cn } from '@repo/ui';
import { Save } from 'lucide-react';
import { useState, type KeyboardEvent } from 'react';
import { useTranslations } from 'use-intl';
import { NotSentError } from '../../lib/api/errors';
import { updateProduct } from '../../lib/api/writes-catalog';
import { CheckField } from '../common/CheckField';
import { Panel } from '../common/Panel';
import { ReasonDialog } from '../common/ReasonDialog';
import { useAdminAction } from '../common/use-admin-action';
import { FormField } from './FormField';
import { productChange, productDraftOf, type ProductTextField } from './product-edit-diff';

type Lang = 'uz' | 'ru';
const LANGS: readonly Lang[] = ['uz', 'ru'];
const LOCALISED = {
  uz: { name: 'nameUz', description: 'descriptionUz', help: 'helpUz' },
  ru: { name: 'nameRu', description: 'descriptionRu', help: 'helpRu' },
} as const;

/**
 * The product's texts and switches (AdminOps.dc.html `product`: UZ/RU tabs, name, description,
 * help). Only the changed fields are sent, after a reason (S7b dialog). Category, delivery type
 * and the input schema are not editable in the panel (D-63 (8)).
 */
export function ProductEditForm({ product }: { product: AdminProductDetailResponse }) {
  const t = useTranslations();
  const act = useAdminAction();
  const [lang, setLang] = useState<Lang>('uz');
  const [draft, setDraft] = useState(() => productDraftOf(product));
  const [saving, setSaving] = useState(false);
  const change = productChange(product, draft);
  const set = (field: ProductTextField) => (value: string) =>
    setDraft({ ...draft, [field]: value });
  const error = (field: ProductTextField) =>
    change.invalid.includes(field) ? t('admin.catalog.form.invalid') : null;
  const text = (
    field: ProductTextField,
    label: string,
    extra: { hint?: string; code?: boolean; multiline?: boolean } = {},
  ) => (
    <FormField
      label={label}
      value={draft[field]}
      onChange={set(field)}
      error={error(field)}
      {...extra}
    />
  );
  const onTabKey = (event: KeyboardEvent<HTMLButtonElement>) => {
    if (event.key !== 'ArrowRight' && event.key !== 'ArrowLeft') return;
    event.preventDefault();
    const next = lang === 'uz' ? 'ru' : 'uz';
    setLang(next);
    document.getElementById(`lang-tab-${next}`)?.focus();
  };
  const keys = LOCALISED[lang];
  const flag = (key: 'isActive' | 'isFeatured', label: string) => (
    <CheckField
      label={label}
      checked={draft[key]}
      onChange={(value) => setDraft({ ...draft, [key]: value })}
    />
  );
  return (
    <Panel title={t('admin.catalog.edit.title')}>
      <div
        role="tablist"
        aria-label={t('admin.catalog.edit.langLabel')}
        className="flex gap-1 border-b border-border"
      >
        {LANGS.map((one) => (
          <button
            key={one}
            id={`lang-tab-${one}`}
            type="button"
            role="tab"
            aria-selected={lang === one}
            aria-controls="lang-panel"
            tabIndex={lang === one ? 0 : -1}
            onClick={() => setLang(one)}
            onKeyDown={onTabKey}
            className={cn(
              'relative h-10 rounded-xs px-2.5 text-xs leading-none font-extrabold',
              lang === one
                ? 'text-foreground'
                : 'text-foreground-muted hover:text-foreground-secondary',
              FOCUS_RING,
            )}
          >
            {t(one === 'uz' ? 'admin.catalog.edit.langUz' : 'admin.catalog.edit.langRu')}
            <span
              aria-hidden="true"
              className={cn(
                'absolute right-1.5 -bottom-px left-1.5 h-0.5',
                lang === one ? 'bg-primary' : 'bg-transparent',
              )}
            />
          </button>
        ))}
      </div>
      <div
        id="lang-panel"
        role="tabpanel"
        aria-labelledby={`lang-tab-${lang}`}
        className="flex flex-col gap-2.5"
      >
        {text(keys.name, t('admin.catalog.edit.name'))}
        {text(keys.description, t('admin.catalog.edit.description'), { multiline: true })}
        {text(keys.help, t('admin.catalog.edit.help'), { multiline: true })}
      </div>
      <div className="grid grid-cols-1 gap-2.5 sm:grid-cols-2">
        {text('regionBadge', t('admin.catalog.edit.region'), {
          hint: t('admin.catalog.edit.regionHint'),
          code: true,
        })}
        {text('imageUrl', t('admin.catalog.edit.image'), {
          hint: t('admin.catalog.edit.imageHint'),
          code: true,
        })}
        {flag('isActive', t('admin.catalog.edit.active'))}
        {flag('isFeatured', t('admin.catalog.edit.featured'))}
      </div>
      <p className="m-0 text-[11px] leading-[15px] font-semibold text-foreground-muted">
        {t('admin.catalog.edit.fixedHint')}
      </p>
      <div className="flex flex-wrap items-center justify-end gap-2 border-t border-border pt-3">
        <span
          className="mr-auto text-xs leading-4 font-bold text-foreground-muted"
          aria-live="polite"
        >
          {change.fields.length > 0
            ? t('admin.catalog.edit.unsaved', { count: change.fields.length })
            : t('admin.catalog.form.noChanges')}
        </span>
        <Button
          type="button"
          variant="outline"
          size="sm"
          disabled={change.fields.length === 0}
          onClick={() => setDraft(productDraftOf(product))}
        >
          {t('admin.catalog.edit.reset')}
        </Button>
        <Button
          type="button"
          size="sm"
          disabled={change.body === null}
          onClick={() => setSaving(true)}
        >
          <Icon icon={Save} size={14} />
          {t('admin.catalog.edit.save')}
        </Button>
      </div>
      <ReasonDialog
        action={act.idOf('catalog.productUpdate', product.id)}
        open={saving}
        onOpenChange={setSaving}
        title={t('admin.catalog.edit.dialog.title')}
        description={t('admin.catalog.edit.dialog.body', {
          name: product.nameUz,
          fields: change.fields.map((field) => t(`admin.catalog.edit.field.${field}`)).join(', '),
        })}
        icon={Save}
        submitLabel={t('admin.catalog.edit.dialog.cta')}
        actor={act.actor}
        extraValid={change.body !== null}
        onOutcomeFound={(applied) => act.found('catalog.productUpdate', applied)}
        onSubmit={async ({ reason, idempotencyKey }) => {
          if (change.body === null) throw new NotSentError();
          const result = await updateProduct(
            product.id,
            { ...change.body, reason },
            idempotencyKey,
          );
          act.finished('catalog.productUpdate', result);
        }}
      />
    </Panel>
  );
}
