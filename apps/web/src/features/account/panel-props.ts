import type { AccountPaths } from './use-account-paths';

/** What the two history panels (orders, ledger) get from the screen. */
export interface PanelProps {
  variant: 'tg' | 'web';
  paths: AccountPaths;
  page: number;
  onPage: (page: number) => void;
}
