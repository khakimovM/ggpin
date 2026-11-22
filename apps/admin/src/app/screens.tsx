import type { RouteObject } from 'react-router';
import { AdminsPage } from '../features/admins/AdminsPage';
import { AuditPage } from '../features/audit/AuditPage';
import { ProductDetailPage } from '../features/catalog/ProductDetailPage';
import { ProductsPage } from '../features/catalog/ProductsPage';
import { DashboardPage } from '../features/dashboard/DashboardPage';
import { FragmentPage } from '../features/infra/FragmentPage';
import { QueuesPage } from '../features/infra/QueuesPage';
import { WalletPage } from '../features/infra/WalletPage';
import { OrderDetailPage } from '../features/orders/OrderDetailPage';
import { OrdersPage } from '../features/orders/OrdersPage';
import { ReviewQueuePage } from '../features/orders/ReviewQueuePage';
import { PaymentsPage } from '../features/payments/PaymentsPage';
import { PricingPage } from '../features/pricing/PricingPage';
import { ReconPage } from '../features/recon/ReconPage';
import { UserDetailPage } from '../features/users/UserDetailPage';
import { UsersPage } from '../features/users/UsersPage';

/** The screens of the panel under the shell (one path per section, plus the detail pages). */
export const screenRoutes: RouteObject[] = [
  { path: 'dashboard', element: <DashboardPage /> },
  { path: 'orders', element: <OrdersPage /> },
  { path: 'orders/:id', element: <OrderDetailPage /> },
  { path: 'review', element: <ReviewQueuePage /> },
  { path: 'users', element: <UsersPage /> },
  { path: 'users/:id', element: <UserDetailPage /> },
  { path: 'products', element: <ProductsPage /> },
  { path: 'products/:id', element: <ProductDetailPage /> },
  { path: 'pricing', element: <PricingPage /> },
  { path: 'payments', element: <PaymentsPage /> },
  { path: 'recon', element: <ReconPage /> },
  { path: 'wallet', element: <WalletPage /> },
  { path: 'fragment', element: <FragmentPage /> },
  { path: 'queues', element: <QueuesPage /> },
  { path: 'audit', element: <AuditPage /> },
  { path: 'admins', element: <AdminsPage /> },
];
