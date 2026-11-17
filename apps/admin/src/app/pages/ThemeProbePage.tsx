import { Badge, Button } from '@repo/ui';
import { useTranslations } from 'use-intl';
import { ThemeToggle } from '../shell/ThemeToggle';

/**
 * Development only (the route exists under `import.meta.env.DEV`; prod-build-check proves it is
 * absent from a build). e2e/theme.spec.ts reads the computed colours of these two components to
 * prove that the shared stylesheet reaches the admin bundle in both themes.
 */
export function ThemeProbePage() {
  const t = useTranslations();
  return (
    <main className="flex min-h-dvh flex-col items-start gap-4 bg-background p-6 text-foreground">
      <h1 className="m-0 text-[22px] leading-7 font-extrabold">{t('admin.probe.title')}</h1>
      <ThemeToggle />
      <Button variant="danger" data-testid="probe-danger">
        {t('admin.probe.danger')}
      </Button>
      <Badge variant="premium" data-testid="probe-premium">
        {t('admin.probe.premium')}
      </Badge>
    </main>
  );
}
