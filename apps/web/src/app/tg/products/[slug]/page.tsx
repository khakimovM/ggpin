import { ProductScreen } from '../../../../features/product/ProductScreen';

// The Mini App product page. The gate, providers and Telegram connection live in the layout
// (TgRoot); this renders only once a session exists.
export default async function TelegramProductPage({
  params,
}: {
  params: Promise<{ slug: string }>;
}) {
  const { slug } = await params;
  return <ProductScreen variant="tg" slug={slug} />;
}
