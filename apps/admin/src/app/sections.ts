import { ADMIN_PERMISSIONS, type AdminPermission, type AdminRole } from '@repo/shared';
import {
  ClipboardCheck,
  CreditCard,
  KeyRound,
  LayoutDashboard,
  Layers,
  Package,
  Scale,
  ScrollText,
  ShieldCheck,
  ShoppingBag,
  SlidersHorizontal,
  Users,
  Wallet,
  type LucideIcon,
} from 'lucide-react';

// The sections of the panel (Admin.dc.html sidebar, D-63 Q12: Marketing, Voucherlar and
// Ta’minotchilar stay hidden until their phases). Each names the read permission of its screen;
// the API decides, the panel only shows the lock state (Q13) instead of an empty 404.

export type SectionId =
  | 'dashboard'
  | 'orders'
  | 'review'
  | 'users'
  | 'products'
  | 'pricing'
  | 'payments'
  | 'recon'
  | 'wallet'
  | 'fragment'
  | 'queues'
  | 'audit'
  | 'admins';

export type SectionGroupId = 'main' | 'catalog' | 'finance' | 'infra' | 'system';

export interface Section {
  id: SectionId;
  path: `/${string}`;
  icon: LucideIcon;
  permission: AdminPermission;
}

export const SECTION_GROUPS: readonly { id: SectionGroupId; sections: readonly Section[] }[] = [
  {
    id: 'main',
    sections: [
      { id: 'dashboard', path: '/dashboard', icon: LayoutDashboard, permission: 'dashboard.read' },
      { id: 'orders', path: '/orders', icon: ShoppingBag, permission: 'orders.read' },
      { id: 'review', path: '/review', icon: ClipboardCheck, permission: 'orders.read' },
      { id: 'users', path: '/users', icon: Users, permission: 'users.read' },
    ],
  },
  {
    id: 'catalog',
    sections: [
      { id: 'products', path: '/products', icon: Package, permission: 'catalog.read' },
      { id: 'pricing', path: '/pricing', icon: SlidersHorizontal, permission: 'settings.read' },
    ],
  },
  {
    id: 'finance',
    sections: [
      { id: 'payments', path: '/payments', icon: CreditCard, permission: 'payments.read' },
      { id: 'recon', path: '/recon', icon: Scale, permission: 'payments.read' },
    ],
  },
  {
    id: 'infra',
    sections: [
      { id: 'wallet', path: '/wallet', icon: Wallet, permission: 'infra.read' },
      { id: 'fragment', path: '/fragment', icon: KeyRound, permission: 'infra.read' },
      { id: 'queues', path: '/queues', icon: Layers, permission: 'infra.read' },
    ],
  },
  {
    id: 'system',
    sections: [
      { id: 'audit', path: '/audit', icon: ScrollText, permission: 'audit.read' },
      { id: 'admins', path: '/admins', icon: ShieldCheck, permission: 'admins.read' },
    ],
  },
];

export const SECTIONS: readonly Section[] = SECTION_GROUPS.flatMap((group) => group.sections);

/** Roles that hold a permission, from the shared matrix (for the lock state's text). */
export function rolesFor(permission: AdminPermission): readonly AdminRole[] {
  return ADMIN_PERMISSIONS[permission].roles;
}

/** Where a signed-in admin lands: the first section the role may open (SUPPORT has no dashboard). */
export function homePathFor(permissions: readonly AdminPermission[]): string {
  return SECTIONS.find((section) => permissions.includes(section.permission))?.path ?? '/orders';
}

/** The section a pathname belongs to (`/orders/123` -> orders). */
export function sectionOf(pathname: string): Section | undefined {
  return SECTIONS.find(
    (section) => pathname === section.path || pathname.startsWith(`${section.path}/`),
  );
}
