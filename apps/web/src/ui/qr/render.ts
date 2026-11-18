import { QUIET_ZONE, qrMatrix, type QrMatrix } from './matrix';

/**
 * Drawing the pairing QR for people: an SVG for the screen, a PNG to save. Always black
 * modules on white with the full quiet zone, whatever the app theme, because many
 * scanners can't read light-on-dark codes and need the white border to find the symbol.
 */

/** SVG markup: one path, crisp edges, white background including the quiet zone. */
export function qrSvg(m: QrMatrix, margin = QUIET_ZONE): string {
  const side = m.size + 2 * margin;
  let d = '';
  for (let r = 0; r < m.size; r++) {
    for (let c = 0; c < m.size; c++) if (m.dark(r, c)) d += `M${c + margin} ${r + margin}h1v1h-1z`;
  }
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${side} ${side}" shape-rendering="crispEdges">` +
    `<rect width="${side}" height="${side}" fill="#fff"/><path fill="#000" d="${d}"/></svg>`
  );
}

export function qrSvgDataUrl(text: string): string {
  return 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(qrSvg(qrMatrix(text)));
}

/** Pixels per module in the saved PNG: sharp after chat apps recompress it. */
const PNG_SCALE = 12;

/** A PNG of the QR with the code printed underneath (for typing it if scanning fails). */
export async function qrPngBlob(text: string): Promise<Blob> {
  const m = qrMatrix(text);
  const qrSide = (m.size + 2 * QUIET_ZONE) * PNG_SCALE;
  const caption = 92;
  const canvas = document.createElement('canvas');
  canvas.width = qrSide;
  canvas.height = qrSide + caption;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('unsupported-environment');
  ctx.fillStyle = '#fff';
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.fillStyle = '#000';
  for (let r = 0; r < m.size; r++) {
    for (let c = 0; c < m.size; c++) {
      if (m.dark(r, c)) ctx.fillRect((c + QUIET_ZONE) * PNG_SCALE, (r + QUIET_ZONE) * PNG_SCALE, PNG_SCALE, PNG_SCALE);
    }
  }
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillStyle = '#555';
  ctx.font = '600 20px system-ui, sans-serif';
  ctx.fillText('Meme Pals pairing code', qrSide / 2, qrSide + 14);
  ctx.fillStyle = '#000';
  const half = Math.ceil(text.length / 2 / 5) * 5; // split after a dash: "XXXX-XXXX-XXXX-XXXX-" / "XXXX-…"
  ctx.font = '600 24px ui-monospace, Menlo, Consolas, monospace';
  ctx.fillText(text.slice(0, half).replace(/-$/, ''), qrSide / 2, qrSide + 46);
  ctx.fillText(text.slice(half), qrSide / 2, qrSide + 76);
  return new Promise((resolve, reject) => canvas.toBlob((b) => (b ? resolve(b) : reject(new Error('unsupported-environment'))), 'image/png'));
}

export const QR_PNG_NAME = 'meme-pals-pairing-code.png';

export function downloadBlob(blob: Blob, name: string): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  a.rel = 'noopener';
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}
