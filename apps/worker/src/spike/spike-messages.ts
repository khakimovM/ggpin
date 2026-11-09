// Phase 4 S0 spike: message fields, live updates and history paging. Never merged to main.
import type { Message, TelegramClient } from '@mtcute/node';
import type { InputPeerLike } from '@mtcute/node';

type GetHistoryOffset = { id: number; date: number };
import { out } from './spike-util';

/** Prints where each S7-relevant field lives and what shape it has. Never prints values. */
export function describeMessage(
  label: string,
  msg: Message,
  expectChatId: number,
  expectSenderId: number,
): void {
  const sender = msg.sender;
  out(`${label}.raw._`, `const:${msg.raw._}`);
  out(`${label}.id`, `type:${typeof msg.id}`);
  out(`${label}.chat.type`, `const:${msg.chat.type}`);
  out(`${label}.chat.id===expected`, msg.chat.id === expectChatId);
  out(`${label}.raw.peerId._`, `const:${msg.raw.peerId._}`);
  out(`${label}.sender.type`, `const:${sender.type}`);
  out(`${label}.sender.id===expected`, sender.id === expectSenderId);
  out(`${label}.sender.isBot`, sender.type === 'user' ? sender.isBot : null);
  out(`${label}.raw.fromId._`, `const:${msg.raw.fromId?._ ?? 'undefined'}`);
  out(`${label}.isOutgoing`, msg.isOutgoing);
  out(`${label}.date.isDate`, msg.date instanceof Date);
  out(`${label}.date===raw.date*1000`, msg.date.getTime() === msg.raw.date * 1000);
  out(`${label}.editDate`, msg.editDate === null ? null : `type:${msg.editDate.constructor.name}`);
  const fwd = msg.forward;
  out(`${label}.forward`, fwd === null ? null : `type:${fwd.constructor.name}`);
  if (fwd !== null) {
    out(`${label}.forward.raw._`, `const:${fwd.raw._}`);
    out(`${label}.forward.date.isDate`, fwd.date instanceof Date);
    out(`${label}.forward.date<msg.date`, fwd.date.getTime() < msg.date.getTime());
    out(`${label}.forward.sender.type`, `const:${fwd.sender.type}`);
    out(`${label}.forward.raw.fromId._`, `const:${fwd.raw.fromId?._ ?? 'undefined'}`);
  }
  out(`${label}.viaBot`, msg.viaBot === null ? null : `type:${msg.viaBot.constructor.name}`);
  if (msg.viaBot !== null) out(`${label}.viaBot.isBot`, msg.viaBot.isBot);
  out(`${label}.raw.viaBotId`, msg.raw._ === 'message' && msg.raw.viaBotId !== undefined);
  out(`${label}.text.type`, `type:${typeof msg.text}`);
  out(`${label}.media`, msg.media === null ? null : `const:${msg.media.type}`);
}

/**
 * Proposed S7 fetchSince: everything with id > minId, OLDEST FIRST, page by page;
 * an empty page means the end. getHistory(reverse=true) starts at offset.id INCLUSIVE.
 */
export async function fetchSince(
  tg: TelegramClient,
  peer: InputPeerLike,
  minId: number,
  pageSize: number,
): Promise<{ pages: number[][]; all: Message[] }> {
  const pages: number[][] = [];
  const all: Message[] = [];
  let offset: GetHistoryOffset = { id: minId + 1, date: 0 };
  for (let i = 0; i < 100; i++) {
    const page = await tg.getHistory(peer, { reverse: true, offset, limit: pageSize });
    pages.push(page.map((m) => m.id));
    if (page.length === 0) break;
    all.push(...page);
    const last = page[page.length - 1];
    if (last === undefined) break;
    offset = { id: last.id + 1, date: 0 };
  }
  return { pages, all };
}

export async function checkHistory(
  label: string,
  tg: TelegramClient,
  peer: InputPeerLike,
  knownIds: number[],
): Promise<Message[]> {
  const sorted = [...knownIds].sort((a, b) => a - b);
  const first = sorted[0];
  if (first === undefined) throw new Error('checkHistory: no ids');
  const minId = first - 1;

  // 1) plain getHistory with minId: newest first, minId exclusive
  const plain = await tg.getHistory(peer, { minId, limit: 100 });
  const plainIds = plain.map((m) => m.id);
  out(`${label}.getHistory(minId).count`, plainIds.length);
  out(
    `${label}.getHistory(minId).newestFirst`,
    plainIds.every((id, i) => i === 0 || (plainIds[i - 1] ?? 0) > id),
  );
  out(
    `${label}.getHistory(minId).allAboveMinId`,
    plainIds.every((id) => id > minId),
  );
  out(
    `${label}.getHistory(minId).containsAllKnown`,
    sorted.every((id) => plainIds.includes(id)),
  );
  const excl = await tg.getHistory(peer, { minId: first, limit: 100 });
  out(`${label}.getHistory(minId=firstKnown).excludesFirst`, !excl.some((m) => m.id === first));

  // 2) fetchSince, page size 2, oldest first
  const { pages, all } = await fetchSince(tg, peer, minId, 2);
  const ids = all.map((m) => m.id);
  out(
    `${label}.fetchSince.pageSizes`,
    pages.map((p) => String(p.length)),
  );
  out(`${label}.fetchSince.lastPageEmpty`, (pages[pages.length - 1] ?? [1]).length === 0);
  out(
    `${label}.fetchSince.oldestFirstStrict`,
    ids.every((id, i) => i === 0 || (ids[i - 1] ?? 0) < id),
  );
  out(
    `${label}.fetchSince.allAboveMinId`,
    ids.every((id) => id > minId),
  );
  out(
    `${label}.fetchSince.sameSetAsPlain`,
    ids.length === plainIds.length && plainIds.every((id) => ids.includes(id)),
  );
  out(`${label}.fetchSince.noDuplicates`, new Set(ids).size === ids.length);
  // offset inclusive check: starting exactly at a known id returns that id first
  const incl = await tg.getHistory(peer, {
    reverse: true,
    offset: { id: first, date: 0 },
    limit: 1,
  });
  out(`${label}.reverse.offsetInclusive`, incl[0]?.id === first);
  // reverse without offset returns nothing (documented trap)
  const noOffset = await tg.getHistory(peer, {
    reverse: true,
    limit: 5,
    offset: { id: 0, date: 0 },
  });
  out(`${label}.reverse.offsetZero.count`, noOffset.length);
  // past the end: empty page
  const lastId = sorted[sorted.length - 1] ?? first;
  const tail = await tg.getHistory(peer, {
    reverse: true,
    offset: { id: Math.max(lastId, ...ids) + 1, date: 0 },
    limit: 5,
  });
  out(`${label}.fetchSince.pastEnd.count`, tail.length);
  return all;
}
