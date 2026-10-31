import type { DestinationStream } from 'pino';

// In-memory Pino destination: tests read back exactly what would have reached stdout.
export class CaptureStream implements DestinationStream {
  private chunks: string[] = [];

  write(message: string): void {
    this.chunks.push(message);
  }

  /** Raw output, for "this secret appears nowhere" assertions. */
  text(): string {
    return this.chunks.join('');
  }

  /** One parsed object per log line; throws if a line is not JSON (structured-log check). */
  records(): Record<string, unknown>[] {
    return this.chunks
      .join('')
      .split('\n')
      .filter((line) => line !== '')
      .map((line) => JSON.parse(line) as Record<string, unknown>);
  }
}
