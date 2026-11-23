// Card writes of the dev mock (docs/04 «cards/:id/*», OWNER). A no-op (pausing a paused card)
// writes nothing: `applied: false, auditId: null`, like the API's state actions.
import {
  AdminCardChangeResponseSchema,
  AdminCardLimitBodySchema,
  AdminCardPauseBodySchema,
  AdminCardResumeBodySchema,
  AdminCardRetireBodySchema,
  type AdminCard,
} from '@repo/shared';
import type { Journal } from './mock-journal';
import { SECURITY_PAUSED_CARD, codeNeeded } from './mock-step-up';
import { cardsView } from './mock-views';
import { fail, ok, type MockReply, type MockRoute } from './router';
import { checkCode, fieldError, writeRoute } from './write-kit';

type CardPatch = Journal['cards'][string];

function current(cardId: string | undefined, journal: Journal): AdminCard | undefined {
  const card = cardsView().find((one) => one.id === cardId);
  return card === undefined ? undefined : ({ ...card, ...journal.cards[card.id] } as AdminCard);
}

function changed(
  card: AdminCard,
  patch: CardPatch,
  journal: Journal,
  cancelledIntents = 0,
  auditId: string,
): MockReply {
  journal.cards[card.id] = { ...journal.cards[card.id], ...patch };
  return ok({ card: { ...card, ...patch }, cancelledIntents, auditId, applied: true });
}

const noChange = (card: AdminCard): MockReply =>
  ok({ card, cancelledIntents: 0, auditId: null, applied: false });

const response = AdminCardChangeResponseSchema;

export const cardRoutes: readonly MockRoute[] = [
  writeRoute({
    pattern: '/admin/payments/cards/:id/pause',
    permission: 'cards.pause',
    body: AdminCardPauseBodySchema,
    response,
    run: ({ params, body, journal, audit, auditId }) => {
      const card = current(params.id, journal);
      if (card === undefined) return fail('NOT_FOUND');
      if (card.status === 'RETIRED') return fieldError('status', 'RETIRED');
      if (card.autoCreditPaused) return noChange(card);
      audit({
        action: 'CARD_PAUSE',
        targetType: 'TopupCard',
        targetId: card.id,
        reason: body.reason,
      });
      return changed(card, { autoCreditPaused: true }, journal, 0, auditId);
    },
  }),
  writeRoute({
    pattern: '/admin/payments/cards/:id/resume',
    permission: 'cards.resume',
    body: AdminCardResumeBodySchema,
    response,
    run: (context) => {
      const { params, body, journal, audit, auditId } = context;
      const card = current(params.id, journal);
      if (card === undefined) return fail('NOT_FOUND');
      if (card.status === 'RETIRED') return fieldError('status', 'RETIRED');
      if (!card.autoCreditPaused) return noChange(card);
      const security = card.id === SECURITY_PAUSED_CARD;
      if (security && !body.confirmSecurityPause) return fieldError('card', 'SECURITY_PAUSE_OPEN');
      if (security && !body.confirmOverride) return fieldError('card', 'OPEN_PAUSE_REVIEWS');
      const confirmation = {
        action: 'cards.resume' as const,
        targetId: card.id,
        confirmOverride: body.confirmOverride,
        confirmSecurityPause: body.confirmSecurityPause,
      };
      const refused = checkCode(context, { required: codeNeeded(confirmation), confirmation });
      if (refused !== null) return refused;
      audit({
        action: 'CARD_RESUME',
        targetType: 'TopupCard',
        targetId: card.id,
        reason: body.reason,
      });
      return changed(card, { autoCreditPaused: false }, journal, 0, auditId);
    },
  }),
  writeRoute({
    pattern: '/admin/payments/cards/:id/limit',
    permission: 'cards.limit',
    body: AdminCardLimitBodySchema,
    response,
    run: (context) => {
      const { params, body, journal, audit, auditId } = context;
      const card = current(params.id, journal);
      if (card === undefined) return fail('NOT_FOUND');
      if (card.status === 'RETIRED') return fieldError('status', 'RETIRED');
      const confirmation = {
        action: 'cards.limit' as const,
        targetId: card.id,
        receiveLimitTiyin: body.receiveLimitTiyin,
        ...(body.monthlyLimitTiyin === undefined
          ? {}
          : { monthlyLimitTiyin: body.monthlyLimitTiyin }),
      };
      const refused = checkCode(context, { required: codeNeeded(confirmation), confirmation });
      if (refused !== null) return refused;
      const patch: CardPatch = {
        receiveLimitTiyin: body.receiveLimitTiyin,
        ...(body.monthlyLimitTiyin === undefined
          ? {}
          : { monthlyLimitTiyin: body.monthlyLimitTiyin }),
      };
      audit({
        action: 'CARD_LIMIT',
        targetType: 'TopupCard',
        targetId: card.id,
        reason: body.reason,
      });
      return changed(card, patch, journal, 0, auditId);
    },
  }),
  writeRoute({
    pattern: '/admin/payments/cards/:id/retire',
    permission: 'cards.retire',
    body: AdminCardRetireBodySchema,
    response,
    run: (context) => {
      const { params, body, journal, audit, auditId, now } = context;
      const card = current(params.id, journal);
      if (card === undefined) return fail('NOT_FOUND');
      if (card.status === 'RETIRED') return noChange(card);
      const confirmation = {
        action: 'cards.retire' as const,
        targetId: card.id,
        emergency: body.emergency,
      };
      const refused = checkCode(context, { required: true, confirmation });
      if (refused !== null) return refused;
      audit({
        action: body.emergency ? 'CARD_RETIRE_EMERGENCY' : 'CARD_RETIRE',
        targetType: 'TopupCard',
        targetId: card.id,
        reason: body.reason,
      });
      const patch: CardPatch = body.emergency
        ? { status: 'RETIRED', retiredAt: now.toISOString() }
        : { status: 'DRAINING' };
      return changed(card, patch, journal, body.emergency ? 1 : 0, auditId);
    },
  }),
];
