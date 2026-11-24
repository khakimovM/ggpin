import {
  AdminCategoryUpdateBodySchema,
  type AdminCategoryListResponse,
  type AdminCategoryUpdateBody,
} from '@repo/shared';
import { FolderPen } from 'lucide-react';
import { useState } from 'react';
import { useTranslations } from 'use-intl';
import { NotSentError } from '../../lib/api/errors';
import { updateCategory } from '../../lib/api/writes-catalog';
import { formatCount } from '../../lib/format';
import { pendingFields } from '../../lib/idempotency';
import { ReasonDialog } from '../common/ReasonDialog';
import { useAdminAction } from '../common/use-admin-action';
import { FormField } from './FormField';
import { sortOf } from './sku-form-model';

type Category = AdminCategoryListResponse[number];
interface Draft {
  nameUz: string;
  nameRu: string;
  sort: string;
}

/** The changed fields of a category, parsed with the shared body; null when none or invalid. */
export function categoryChange(category: Category, draft: Draft): AdminCategoryUpdateBody | null {
  const sort = sortOf(draft.sort);
  const next = { nameUz: draft.nameUz.trim(), nameRu: draft.nameRu.trim(), sort };
  const changed = Object.fromEntries(
    Object.entries(next).filter(([key, value]) => category[key as keyof Draft] !== value),
  );
  const parsed = AdminCategoryUpdateBodySchema.safeParse(changed);
  return parsed.success ? parsed.data : null;
}

interface Props {
  category: Category;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

export function CategoryEditDialog(props: Props) {
  return props.open ? <CategoryEditOpen {...props} /> : null;
}

/** A category's names and place (no frame in the handoff: the other dialogs' style). */
function CategoryEditOpen({ category, onOpenChange }: Props) {
  const t = useTranslations();
  const act = useAdminAction();
  const action = act.idOf('catalog.categoryUpdate', category.id);
  const [draft, setDraft] = useState<Draft>(() => {
    const sent = pendingFields(action);
    const text = (key: keyof Draft, fallback: string) => {
      const value = sent?.[key];
      return typeof value === 'string' ? value : fallback;
    };
    return {
      nameUz: text('nameUz', category.nameUz),
      nameRu: text('nameRu', category.nameRu),
      sort: text('sort', String(category.sort)),
    };
  });
  const body = categoryChange(category, draft);
  const invalid = (key: keyof Draft) => {
    const ok = key === 'sort' ? sortOf(draft.sort) !== null : draft[key].trim() !== '';
    return ok ? null : t('admin.catalog.form.invalid');
  };
  const field = (key: keyof Draft, label: string, code = false) => (
    <FormField
      label={label}
      value={draft[key]}
      onChange={(value) => setDraft({ ...draft, [key]: value })}
      error={invalid(key)}
      code={code}
      inputMode={code ? 'numeric' : 'text'}
    />
  );
  return (
    <ReasonDialog
      action={action}
      open
      onOpenChange={onOpenChange}
      title={t('admin.catalog.category.dialog.title')}
      description={t('admin.catalog.category.dialog.body', {
        name: category.nameUz,
        count: formatCount(category.productsCount),
      })}
      icon={FolderPen}
      submitLabel={t('admin.catalog.category.dialog.cta')}
      actor={act.actor}
      extraValid={body !== null}
      fields={{ ...draft }}
      onOutcomeFound={() => act.found('catalog.categoryUpdate')}
      onSubmit={async ({ reason, idempotencyKey }) => {
        if (body === null) throw new NotSentError();
        const result = await updateCategory(category.id, { ...body, reason }, idempotencyKey);
        act.finished('catalog.categoryUpdate', result);
      }}
    >
      <div className="grid grid-cols-1 gap-2.5 sm:grid-cols-2">
        {field('nameUz', t('admin.catalog.category.nameUz'))}
        {field('nameRu', t('admin.catalog.category.nameRu'))}
        {field('sort', t('admin.catalog.category.sort'), true)}
      </div>
    </ReasonDialog>
  );
}
