import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { configureApp } from '../../../app.setup';
import { APP_CONFIG } from '../../../config/config.module';
import { AppError } from '../../exceptions/app-error';
import { receivedAtOf } from '../request-received';

// The admin write deadline starts at the onRequest stamp (docs/04 «So‘rov deadline’i», SA L-3):
// a request without one is a server bug (500, never "no deadline"), and the stamp is the FIRST
// hook configureApp registers, so every later hook's time counts.

type Hook = (request: object, reply: object, done: () => void) => void;

/** Just enough of a Nest Fastify app for configureApp: it records the hooks in order. */
function recordingApp() {
  const hooks: { name: string; fn: Hook }[] = [];
  const fastify = { addHook: (name: string, fn: Hook) => hooks.push({ name, fn }) };
  const app = {
    get: (token: unknown) => (token === APP_CONFIG ? { SWAGGER_ENABLED: false } : {}),
    useLogger: () => undefined,
    getHttpAdapter: () => ({ getInstance: () => fastify }),
    setGlobalPrefix: () => undefined,
    enableVersioning: () => undefined,
    enableCors: () => undefined,
    register: () => Promise.resolve(),
  };
  return { app: app as unknown as NestFastifyApplication, hooks };
}

describe('the onRequest receive stamp', () => {
  it('a request the hook never saw has no stamp: INTERNAL_ERROR, not a default', () => {
    let refused: unknown = null;
    try {
      receivedAtOf({});
    } catch (error) {
      refused = error;
    }
    expect(refused).toBeInstanceOf(AppError);
    expect(refused).toMatchObject({ code: 'INTERNAL_ERROR' });
  });

  it('is the first hook configureApp registers, and it stamps the request', async () => {
    const { app, hooks } = recordingApp();
    await configureApp(app);
    expect(hooks.length).toBeGreaterThan(1);
    const first = hooks[0];
    expect(first?.name).toBe('onRequest');
    const request = {};
    const done = jest.fn();
    first?.fn(request, {}, done);
    expect(done).toHaveBeenCalledTimes(1);
    expect(Number.isFinite(receivedAtOf(request))).toBe(true);
    // Every other hook comes after it (the request-id hook among them).
    expect(hooks.slice(1).some((hook) => hook.name === 'onRequest')).toBe(true);
  });
});
