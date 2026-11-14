import { randomUUID } from 'node:crypto';
import { Inject, Injectable, Logger } from '@nestjs/common';
import {
  RECIPIENT_PLACEHOLDER,
  TG_USERNAME_PATTERN,
  storedRecipientView,
  type Locale,
  type OrderNotifyKind,
  type OrderStatus,
  type TgInlineKeyboard,
  type TgOutboxJob,
} from '@repo/shared';
import { escapeHtml } from '../../common/i18n/html';
import { translate } from '../../common/i18n/translate';
import { APP_CONFIG, type AppConfig } from '../../config/config.module';
import { miniAppUrl } from '../telegram/mini-app-url';
import { NotifySourcesRepository } from './notify-sources.repository';
import { moneyText } from './owner-alert.renderer';

/** Why an order message was not queued (the consumer logs it as the job's outcome). */
export type OrderNotifySkip = 'skipped-blocked' | 'skipped-stale';

export type OrderNotifyResult =
  { readonly kind: 'message'; readonly job: TgOutboxJob } | { readonly kind: OrderNotifySkip };

/** The order of an ORDER_* job is gone: the job cannot be rendered (never retried). */
export class OrderSourceMissingError extends Error {
  constructor() {
    super('order of the notification is missing');
    this.name = 'OrderSourceMissingError';
  }
}

type OrderRow = NonNullable<Awaited<ReturnType<NotifySourcesRepository['order']>>>;

/** The recipient's finished HTML and the token that stands in for it while the text renders. */
interface RecipientHtml {
  readonly token: string;
  readonly html: string;
}

interface Params {
  readonly text: Record<string, string>;
  readonly recipient?: RecipientHtml;
}

/** Puts the recipient's HTML where its token was rendered (nothing to do for a text without one). */
function withRecipient(text: string, recipient: RecipientHtml | undefined): string {
  return recipient === undefined ? text : text.split(recipient.token).join(recipient.html);
}

const TEXT_KEY: Readonly<Record<OrderNotifyKind, string>> = {
  ORDER_ACCEPTED: 'bot.order.accepted',
  ORDER_DELIVERED: 'bot.order.delivered',
  ORDER_REVIEW: 'bot.order.reviewing',
  ORDER_REFUNDED: 'bot.order.failedRefunded',
};

// An order that already ended: "accepted" or "being checked" would now be false or confusing, and
// the message of the end itself (delivered / refunded) is on its way.
const ENDED: readonly OrderStatus[] = ['DELIVERED', 'FAILED', 'CANCELLED', 'REFUNDED'];

const USERNAME_KEY = 'bot.order.recipient.username';
const ODD_USERNAME_KEY = 'bot.order.recipient.oddUsername';
const BOTH_KEY = 'bot.order.recipient.nameAndUsername';
const BOTH_ODD_KEY = 'bot.order.recipient.nameAndOddUsername';

/**
 * Customer messages about an order (docs/07 "Bildirishnomalar"): in the customer's language, from
 * the Order row (the owner, the product, the recipient; the job carries the order id only), with
 * a "View order" button to the Mini App `/orders/:id`. `translate` HTML-escapes every parameter:
 * the recipient's name and username and the product name are not ours (S2 audit I7). Nobody who
 * blocked the bot is written to. Each kind is checked against the row NOW, so a late job never
 * says something the order no longer is.
 *
 * The recipient's NAME is printed inside `<code>` (owner decision on S6 audit L-2): it is free
 * text from Telegram, and a name like "ggpin yordam: t.me/evil_bot" must not become a clickable
 * link in our own message. The tags come from the catalog (`bot.order.recipient.*`), the name is
 * escaped like any parameter, so it cannot close the tag. The @username stays plain text only when
 * it matches the Telegram username pattern (a mention, nothing to click elsewhere); a stored one
 * that does not (an old row, "t.me/x") goes inside `<code>` too (S6 re-review).
 */
@Injectable()
export class OrderNotifyRenderer {
  private readonly logger = new Logger('OrderNotify');

  constructor(
    private readonly sources: NotifySourcesRepository,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {}

  async render(kind: OrderNotifyKind, orderId: string): Promise<OrderNotifyResult> {
    const order = await this.sources.order(orderId);
    if (order === null) throw new OrderSourceMissingError();
    if (order.user.botBlockedAt !== null) return { kind: 'skipped-blocked' };
    const locale = order.user.locale;
    const params = await this.params(kind, order, locale);
    if (params === null) return { kind: 'skipped-stale' };
    const text = withRecipient(translate(locale, TEXT_KEY[kind], params.text), params.recipient);
    const replyMarkup = this.viewButton(order.id, locale);
    return {
      kind: 'message',
      job: {
        chatId: order.user.telegramId.toString(),
        text,
        ...(replyMarkup === undefined ? {} : { replyMarkup }),
      },
    };
  }

  private async params(
    kind: OrderNotifyKind,
    order: OrderRow,
    locale: Locale,
  ): Promise<Params | null> {
    const number = String(order.number);
    switch (kind) {
      case 'ORDER_ACCEPTED':
      case 'ORDER_REVIEW':
        if (ENDED.includes(order.status)) return null;
        return kind === 'ORDER_REVIEW'
          ? { text: { number } }
          : this.withProduct(number, order, locale);
      case 'ORDER_DELIVERED':
        if (order.deliveredAt === null) return null;
        return this.withProduct(number, order, locale);
      case 'ORDER_REFUNDED': {
        // A delivered order refunded later is an ADMIN refund (S6 review M1): "it did not work
        // out" would be false. Its own message (and a partial refund's) comes with S10.
        if (order.status !== 'REFUNDED' || order.deliveredAt !== null) return null;
        // The amount is the REFUND entry itself (what reached the wallet), never recomputed.
        const refund = await this.sources.orderRefund(order.id);
        if (refund === null) return null;
        return { text: { number, amount: moneyText(refund.amountTiyin, locale) } };
      }
    }
  }

  private withProduct(number: string, order: OrderRow, locale: Locale): Params {
    const recipient = this.recipient(order, locale);
    return {
      text: { number, product: orderProductText(order, locale), recipient: recipient.token },
      recipient,
    };
  }

  /**
   * The recipient as HTML (`<code>name</code> (@username)`, `<code>name</code>` or `@username`)
   * from the name and @username stored on the order (lenient read, S2); an @username that is not
   * a Telegram username is `<code>` as well; a broken row: a dash.
   */
  private recipient(order: OrderRow, locale: Locale): RecipientHtml {
    // A random token stands in for the recipient while the text is rendered (translate escapes
    // every parameter, so the finished HTML cannot be one): letters and digits only, so escaping
    // leaves it as it is, and no product name can contain it by accident.
    const token = `r${randomUUID().replace(/-/g, '')}`;
    const view = storedRecipientView(order.recipient);
    if (view === null) {
      this.logger.warn(`order ${order.id} stores a recipient without a name or username`);
      return { token, html: escapeHtml(RECIPIENT_PLACEHOLDER) };
    }
    const name = view.displayName;
    const username = view.fields['username'];
    if (username === undefined) {
      return { token, html: translate(locale, 'bot.order.recipient.name', { name }) };
    }
    const plain = TG_USERNAME_PATTERN.test(username);
    const html =
      name === username
        ? translate(locale, plain ? USERNAME_KEY : ODD_USERNAME_KEY, { username })
        : translate(locale, plain ? BOTH_KEY : BOTH_ODD_KEY, { name, username });
    return { token, html };
  }

  private viewButton(orderId: string, locale: Locale): TgInlineKeyboard | undefined {
    // Without an https MINI_APP_URL (dev) the message goes out without a button.
    const url = miniAppUrl(this.config, `/orders/${encodeURIComponent(orderId)}`);
    if (url === undefined) return undefined;
    return {
      inline_keyboard: [[{ text: translate(locale, 'bot.order.viewButton'), web_app: { url } }]],
    };
  }
}

/**
 * The product as a message prints it: its name, plus the pack label (`Telegram Premium (3 oylik)`)
 * or, for a free quantity, `× N` (`Telegram Stars × 500`). Raw text: the caller's `translate`
 * escapes it once.
 */
export function orderProductText(
  order: Pick<OrderRow, 'product' | 'sku' | 'quantity'>,
  locale: Locale,
): string {
  const name = locale === 'ru' ? order.product.nameRu : order.product.nameUz;
  if (order.sku !== null)
    return `${name} (${locale === 'ru' ? order.sku.labelRu : order.sku.labelUz})`;
  return order.quantity > 1 ? `${name} × ${String(order.quantity)}` : name;
}
