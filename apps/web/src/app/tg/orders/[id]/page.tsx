import { OrderScreen } from '../../../../features/order/OrderScreen';

// The Mini App order page. The gate and providers live in the layout (TgRoot).
export default async function TelegramOrderPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return <OrderScreen variant="tg" id={id} />;
}
