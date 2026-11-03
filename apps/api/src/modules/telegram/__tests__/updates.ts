import type { Update } from 'grammy/types';

export interface Sender {
  readonly id: number;
  readonly first_name?: string;
  readonly language_code?: string;
}

let updateSeq = 1000;

function person(sender: Sender): {
  id: number;
  is_bot: false;
  first_name: string;
  language_code?: string;
} {
  return {
    id: sender.id,
    is_bot: false,
    first_name: sender.first_name ?? 'Ann',
    ...(sender.language_code === undefined ? {} : { language_code: sender.language_code }),
  };
}

export function textUpdate(sender: Sender, text: string): Update {
  updateSeq += 1;
  const command = text.startsWith('/')
    ? [{ type: 'bot_command' as const, offset: 0, length: text.split(/\s/)[0]?.length ?? 0 }]
    : undefined;
  return {
    update_id: updateSeq,
    message: {
      message_id: updateSeq,
      date: 1_700_000_000,
      chat: { id: sender.id, type: 'private', first_name: sender.first_name ?? 'Ann' },
      from: person(sender),
      text,
      ...(command === undefined ? {} : { entities: command }),
    },
  };
}

export function callbackUpdate(sender: Sender, data: string): Update {
  updateSeq += 1;
  return {
    update_id: updateSeq,
    callback_query: {
      id: `cb-${updateSeq}`,
      chat_instance: 'ci',
      from: person(sender),
      data,
      message: {
        message_id: 1,
        date: 1_700_000_000,
        chat: { id: sender.id, type: 'private', first_name: sender.first_name ?? 'Ann' },
        text: 'x',
      },
    },
  };
}

export function contactUpdate(
  sender: Sender,
  contact: { phone_number: string; user_id?: number },
): Update {
  updateSeq += 1;
  return {
    update_id: updateSeq,
    message: {
      message_id: updateSeq,
      date: 1_700_000_000,
      chat: { id: sender.id, type: 'private', first_name: sender.first_name ?? 'Ann' },
      from: person(sender),
      contact: { first_name: 'Ann', ...contact },
    },
  };
}

export function myChatMemberUpdate(sender: Sender, status: 'kicked' | 'member'): Update {
  updateSeq += 1;
  const user = person(sender);
  return {
    update_id: updateSeq,
    my_chat_member: {
      chat: { id: sender.id, type: 'private', first_name: sender.first_name ?? 'Ann' },
      from: user,
      date: 1_700_000_000,
      old_chat_member: { status: status === 'kicked' ? 'member' : 'kicked', user } as never,
      new_chat_member: status === 'kicked' ? { status, user, until_date: 0 } : { status, user },
    },
  };
}
