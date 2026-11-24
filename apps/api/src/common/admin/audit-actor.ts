import type { AdminPermission } from '@repo/shared';
import type { AdminDeadline } from './admin-deadline';
import { checkedIp, checkedOperator, checkedOsUser, validationError } from './admin-input';

// Who performs an owner money or account action (phase 9 plan §4.6, S6): the owner CLI on the
// server (CLI) or an admin panel session (ADMIN). The services take one of these instead of a
// bare operator name, and write the AuditLog columns and `after` fields from it. The CLI shape is
// the one the CLI always passed (`{ operator, ip?, osUser? }`), so its commands and tests did not
// change.

/** The owner CLI: the operator name and, when known, the SSH client and the OS account. */
export interface CliActor {
  readonly kind?: 'CLI';
  readonly operator: string;
  readonly ip?: string | null;
  /** The OS login (and the sudo caller), AuditLog.after.osUser (S8-L5). */
  readonly osUser?: string | null;
}

/**
 * The acting admin's step-up code, checked by the admin layer against the binding of the
 * confirmation body it rebuilt from the request (docs/04 «Tasdiq kodi»). The service only adds
 * the flags it computed itself (`serverFlags`), never the client.
 */
export interface AdminStepUp {
  verify(serverFlags: readonly string[]): Promise<void>;
}

/** The idempotency of an admin write: the AuditLog id the key maps to and the body's hash. */
export interface AdminRequestKey {
  readonly auditId: string;
  readonly requestHash: string;
}

/** An admin panel session; ids come from the verified session only (AdminGuard). */
export interface AdminActor {
  readonly kind: 'ADMIN';
  readonly adminId: string;
  readonly sessionId: string;
  readonly ip: string | null;
  /** The matrix permission the route performs: re-checked against the role read in the tx. */
  readonly permission: AdminPermission;
  readonly request: AdminRequestKey;
  /**
   * The request's server deadline (docs/04 «So‘rov deadline’i»): checked in confirmActorInTx and
   * before the commit (runActorTransaction). Required here and absent from CliActor on purpose:
   * the owner CLI has no deadline, and a panel write cannot be built without one.
   */
  readonly deadline: AdminDeadline;
  /** Present only when the request carried `otp`. */
  readonly stepUp?: AdminStepUp;
}

export type AuditActor = CliActor | AdminActor;

export function isAdminActor(actor: AuditActor): actor is AdminActor {
  return actor.kind === 'ADMIN';
}

/** The CLI actor with its fields checked (the shape every CLI service used before S6). */
export interface CheckedCliActor {
  readonly operator: string;
  readonly ip: string | null;
  readonly osUser: string | null;
}

export type CheckedAuditActor = (CheckedCliActor & { readonly kind: 'CLI' }) | AdminActor;

/** Checks a CLI actor's free-text fields; an admin actor comes from the guard as it is. */
export function checkedAuditActor(actor: AuditActor): CheckedAuditActor {
  if (isAdminActor(actor)) return actor;
  return {
    kind: 'CLI',
    operator: checkedOperator(actor.operator),
    ip: checkedIp(actor.ip),
    osUser: checkedOsUser(actor.osUser),
  };
}

/**
 * The AuditLog columns of an actor. An admin: its id. The CLI: nothing besides the address; the
 * repositories write `actorType=CLI, actorId=null` themselves (the name is in `after.operator`),
 * as they always did.
 */
export function toAuditColumns(actor: CheckedAuditActor): {
  readonly actorType?: 'ADMIN';
  readonly actorId?: string;
  readonly ip: string | null;
} {
  return isAdminActor(actor)
    ? { actorType: 'ADMIN', actorId: actor.adminId, ip: actor.ip }
    : { ip: actor.ip };
}

/** The AuditLog id an action writes: the admin key's id, else the CLI's own (or a new one). */
export function auditIdOf(actor: CheckedAuditActor, cliAuditId?: string): string | undefined {
  return isAdminActor(actor) ? actor.request.auditId : cliAuditId;
}

/**
 * A service input names its actor either the CLI's way (`operator`, `ip`, `osUser` at the top,
 * as every CLI command and test passes it) or as an `actor` (the panel). One flat shape (not a
 * union) so the CLI's partial inputs keep their types; `actorOfInput` refuses neither or both.
 */
export interface ActorInput {
  readonly actor?: AuditActor;
  /** Who runs the command (the CLI --operator); stored in AuditLog.after.operator. */
  readonly operator?: string;
  /** Optional client address for the AuditLog (IPv4/IPv6 literal). */
  readonly ip?: string | null;
  /** The OS account that ran the CLI (AuditLog.after.osUser). */
  readonly osUser?: string | null;
}

export function actorOfInput(input: ActorInput): AuditActor {
  if (input.actor !== undefined) {
    if (input.operator !== undefined) throw validationError('operator');
    return input.actor;
  }
  if (input.operator === undefined) throw validationError('operator');
  return { operator: input.operator, ip: input.ip ?? null, osUser: input.osUser ?? null };
}
