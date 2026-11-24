import { expect, test } from '@playwright/test';
import http from 'node:http';

// A Host / X-Forwarded-Host the client chose must not reach any response (phase 8 S6 audit L-1).
// next-intl wrote a `Link: rel=alternate` header from them until `alternateLinks: false`; the
// hreflang links of the HTML come from NEXT_PUBLIC_SITE_URL and stay correct. Plain node:http,
// because a browser-like client does not let a test choose the Host header.

const SITE = new URL('http://localhost:3100');
const EVIL = 'evil.example';

type Answer = { status: number; headers: http.IncomingHttpHeaders; body: string };

function get(path: string, headers: Record<string, string>): Promise<Answer> {
  return new Promise((resolve, reject) => {
    const req = http.request(
      { host: SITE.hostname, port: SITE.port, path, method: 'GET', headers },
      (res) => {
        let body = '';
        res.setEncoding('utf8');
        res.on('data', (chunk: string) => {
          body += chunk;
        });
        res.on('end', () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body }));
      },
    );
    req.on('error', reject);
    req.end();
  });
}

const HOSTILE: Record<string, string>[] = [
  { host: EVIL },
  { host: SITE.host, 'x-forwarded-host': EVIL },
  { host: EVIL, 'x-forwarded-host': EVIL, 'x-forwarded-proto': 'https' },
];

test.describe('a foreign Host header', () => {
  for (const path of ['/', '/ru', '/faq', '/ru/telegram-stars']) {
    for (const headers of HOSTILE) {
      test(`${path} ${JSON.stringify(headers)}: not in any header or the HTML`, async () => {
        const answer = await get(path, headers);
        expect(answer.status).toBe(200);
        expect(JSON.stringify(answer.headers)).not.toContain(EVIL);
        expect(answer.body).not.toContain(EVIL);
        // The hreflang links still name the site's own origin (NEXT_PUBLIC_SITE_URL).
        const alternates = [
          ...answer.body.matchAll(/<link[^>]*rel="alternate"[^>]*hrefLang="([^"]+)"[^>]*>/gi),
        ].map((match) => match[0]);
        expect(alternates.length).toBe(3);
        for (const link of alternates) expect(link).toContain(`href="${SITE.origin}`);
      });
    }
  }
});
