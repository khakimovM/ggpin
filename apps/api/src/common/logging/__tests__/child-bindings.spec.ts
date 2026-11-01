import type { DestinationStream } from 'pino';
import { pinoHttp, type Options } from 'pino-http';
import { buildLoggerParams } from '../logger-params';
import { CaptureStream } from './capture-stream';

function createLogger() {
  const stream = new CaptureStream();
  const params = buildLoggerParams({ LOG_LEVEL: 'info', NODE_ENV: 'test' }, stream);
  const [options, destination] = params.pinoHttp as [Options, DestinationStream];
  return { stream, logger: pinoHttp(options, destination).logger };
}

describe('API logger: child bindings keep exact BigInt digits', () => {
  it('prints a BigInt binding without losing precision (RA-15)', () => {
    const { stream, logger } = createLogger();
    logger.child({ amountTiyin: 12345678901234567891n, userId: 'u-1' }).info('charged');
    // Raw text, not records(): JSON.parse would round the number again.
    expect(stream.text()).toContain('"amountTiyin":"12345678901234567891"');
    expect(stream.text()).toContain('"userId":"u-1"');
  });
});
