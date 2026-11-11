import { isDbConnectionError } from '../db-outage';

// Error shapes as Prisma 7 with @prisma/adapter-pg and node-postgres produce them, built by hand.
function prismaError(code: string, meta?: object): Error {
  return Object.assign(new Error('synthetic'), {
    name: 'PrismaClientKnownRequestError',
    code,
    meta,
  });
}

function adapterError(cause: object): Error {
  return prismaError('P2010', { driverAdapterError: { cause } });
}

describe('isDbConnectionError', () => {
  it.each(['P1001', 'P1002', 'P1008', 'P1017', 'P2024'])('Prisma %s is an outage', (code) => {
    expect(isDbConnectionError(prismaError(code))).toBe(true);
  });

  it('review L1: P2028 (transaction not started within maxWait, or past its timeout) is an outage', () => {
    // The shape recorded against the test DB: a top-level P2028, no adapter cause.
    const notStarted = Object.assign(
      new Error('Transaction API error: Unable to start a transaction in the given time.'),
      { name: 'PrismaClientKnownRequestError', code: 'P2028', meta: {} },
    );
    expect(isDbConnectionError(notStarted)).toBe(true);
    expect(isDbConnectionError(new Error('wrapped', { cause: prismaError('P2028') }))).toBe(true);
  });

  it.each(['DatabaseNotReachable', 'ConnectionClosed', 'SocketTimeout', 'TooManyConnections'])(
    'adapter kind %s is an outage',
    (kind) => {
      expect(isDbConnectionError(adapterError({ kind }))).toBe(true);
    },
  );

  it.each(['08006', '08001', '57P01', '57P02', '57P03'])('SQLSTATE %s is an outage', (code) => {
    expect(isDbConnectionError(adapterError({ kind: 'postgres', originalCode: code }))).toBe(true);
    const pg = Object.assign(new Error('synthetic'), { code, severity: 'FATAL' });
    expect(isDbConnectionError(pg)).toBe(true);
  });

  it('looks through wrapping causes and reads node-postgres socket wording', () => {
    const inner = prismaError('P1017');
    expect(
      isDbConnectionError(new Error('outer', { cause: new Error('mid', { cause: inner }) })),
    ).toBe(true);
    expect(isDbConnectionError(new Error('Connection terminated unexpectedly'))).toBe(true);
  });

  it.each([
    ['unique violation', prismaError('P2002')],
    ['lock timeout', adapterError({ kind: 'postgres', originalCode: '55P03' })],
    ['trigger refusal', adapterError({ kind: 'postgres', originalCode: 'GG001' })],
    ['check violation', adapterError({ kind: 'postgres', originalCode: '23514' })],
    ['a pg-like code without severity', Object.assign(new Error('x'), { code: '08006' })],
    ['plain error', new Error('boom')],
    ['not an error', 'P1001'],
    ['null', null],
  ])('%s is NOT an outage (still fails closed)', (_name, error) => {
    expect(isDbConnectionError(error)).toBe(false);
  });
});
