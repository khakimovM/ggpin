import type { ReviewResolver } from '@repo/db';
import {
  checkedIp,
  checkedOperator,
  checkedOsUser,
  validationError,
} from '../../../common/admin/admin-input';

/**
 * Where an owner action comes from. The owner CLI binary provides the CLI channel
 * (cli/cli-channel.ts, OpsCliModule only); the HTTP application (AppModule) provides nothing, so a
 * service that needs the channel cannot even be built there, and `type: 'CLI'` resolvers are
 * minted only here, from the injected channel, never from a request (plan S10, audit I-4). The
 * admin panel (phase 9) gets its own channel with `type: 'ADMIN'` resolvers whose OWNER role
 * @repo/db re-reads from AdminUser.
 *
 * The channel is ONE frozen object held in this module (CR i4, audit L-3), not a string: the
 * checks below compare by identity, so a `'CLI'` literal or a look-alike object built elsewhere is
 * refused at run time and does not type-check. The only way to get it is `cliChannelForCliModule`,
 * and a static test (operator-channel.e2e-spec.ts) allows that call in cli/cli-channel.ts only, and
 * `cliResolver(` / `assertOwnerChannel(` only in the owner services, across apps/api and apps/worker.
 */
export const OPERATOR_CHANNEL = Symbol('OPERATOR_CHANNEL');

declare const CLI_BRAND: unique symbol;
export interface OperatorChannel {
  readonly kind: 'CLI';
  readonly [CLI_BRAND]: true;
}

const CLI_CHANNEL = Object.freeze({ kind: 'CLI' }) as OperatorChannel;

/** The CLI channel. Only cli/cli-channel.ts may call this (static test). */
export function cliChannelForCliModule(): OperatorChannel {
  return CLI_CHANNEL;
}

/** Who runs the owner command: the typed operator name, the SSH client address, the OS login. */
export interface OwnerActor {
  readonly operator: string;
  readonly ip: string | null;
  readonly osUser: string | null;
}

export function checkedActor(input: {
  readonly operator: string;
  readonly ip?: string | null;
  readonly osUser?: string | null;
}): OwnerActor {
  return {
    operator: checkedOperator(input.operator),
    ip: checkedIp(input.ip),
    osUser: checkedOsUser(input.osUser),
  };
}

/**
 * The owner role of the CLI (D-46: the CLI has no AdminUser row, SSH access is the control): only
 * a process whose channel is the CLI may run an owner action. Anything else is refused before a
 * row is read. A runtime check, because the channel arrives through DI, not through the type system.
 */
export function assertOwnerChannel(channel: unknown): asserts channel is OperatorChannel {
  if (channel !== CLI_CHANNEL) throw validationError('actor', 'OWNER_REQUIRED');
}

/** The resolver `resolveNeedsReview` gets for an owner CLI action (D-46: counts as OWNER). */
export function cliResolver(
  channel: unknown,
  actor: OwnerActor,
  otpVerified: boolean,
): ReviewResolver {
  assertOwnerChannel(channel);
  return {
    kind: 'operator',
    type: 'CLI',
    id: actor.operator,
    ip: actor.ip,
    osUser: actor.osUser,
    otpVerified,
  };
}

/**
 * The HTTP boundary's guard (I-4): whatever an HTTP caller sends, a resolver of `type: 'CLI'` (or
 * the reconciler) is refused; the admin panel builds its own ADMIN resolver from the session.
 * Phase 5 has no HTTP route that resolves an order; this is the rule that route must apply.
 */
export function refuseCliResolverOverHttp(resolver: unknown): void {
  if (typeof resolver !== 'object' || resolver === null) return;
  const candidate = resolver as Record<string, unknown>;
  if (candidate['type'] === 'CLI' || candidate['kind'] === 'reconciler') {
    throw validationError('resolver', 'NOT_ALLOWED_OVER_HTTP');
  }
}
