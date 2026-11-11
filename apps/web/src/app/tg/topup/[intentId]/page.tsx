import { Suspense } from 'react';
import { TopupWaiting } from '../../../../features/topup/TopupWaiting';

export default async function TelegramTopupWaitingPage({
  params,
}: {
  params: Promise<{ intentId: string }>;
}) {
  const { intentId } = await params;
  return (
    <Suspense fallback={null}>
      <TopupWaiting intentId={intentId} />
    </Suspense>
  );
}
