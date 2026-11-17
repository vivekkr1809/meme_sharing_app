import type { ServerResponse } from 'node:http';

/** Headers on every API / proxy response. */
export const API_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Cache-Control': 'no-store',
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
} as const;

export function sendJson(res: ServerResponse, status: number, body: unknown, headOnly = false): void {
  if (res.headersSent) {
    res.destroy();
    return;
  }
  const buf = Buffer.from(JSON.stringify(body));
  res.writeHead(status, { ...API_HEADERS, 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': buf.length });
  res.end(headOnly ? undefined : buf);
}
