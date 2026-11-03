/** The authenticated caller, as attached to the request by UserAuthGuard. */
export interface AuthUser {
  readonly id: string;
  readonly telegramId: bigint;
  /** 'tg' = Mini App bearer token, 'web' = httpOnly cookie session. */
  readonly channel: 'tg' | 'web';
  /** Web sessions only: the family id the access token was issued for. */
  readonly sessionFamilyId?: string;
}

/**
 * The slice of the Fastify request the auth guards and @CurrentUser read (structural, so no
 * direct `fastify` import). `cookies` is added by @fastify/cookie.
 */
export interface AuthRequest {
  readonly method: string;
  readonly headers: Readonly<Record<string, string | string[] | undefined>>;
  readonly cookies?: Readonly<Record<string, string | undefined>>;
  authUser?: AuthUser;
}
