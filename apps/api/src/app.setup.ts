import { VersioningType, type INestApplication } from '@nestjs/common';

// Shared by main.ts and tests, so the HTTP surface under test is exactly what ships.
export function configureApp(app: INestApplication): void {
  app.setGlobalPrefix('api');
  app.enableVersioning({ type: VersioningType.URI, defaultVersion: '1' });
}
