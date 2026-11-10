import { ownerAlertChatIds } from '@repo/shared';
import { maskChatId } from './chat-id-mask';

/**
 * The one boot line about who gets owner alerts (D-53): the count and the masked PRIMARY id only,
 * so an operator can see a typo in the env without a full Telegram id reaching the logs. A
 * missing or unusable value reports zero (production refuses to boot without one).
 */
export function ownerAlertRecipientsLine(raw: string | undefined): string {
  const [primary] = ownerAlertChatIds(raw);
  const count = ownerAlertChatIds(raw).length;
  return primary === undefined
    ? 'owner alert recipients: 0'
    : `owner alert recipients: ${String(count)}, primary ${maskChatId(primary)}`;
}
