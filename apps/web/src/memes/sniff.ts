/** Image formats we recognise from magic bytes. */
export type SniffedMime =
  | 'image/jpeg'
  | 'image/png'
  | 'image/gif'
  | 'image/webp'
  | 'image/avif'
  | 'image/heic'
  | 'image/bmp';

/** Formats we're willing to store and send as a meme as-is (fetched from the Internet). */
export const MEME_MIMES: ReadonlySet<string> = new Set(['image/jpeg', 'image/png', 'image/gif', 'image/webp', 'image/avif']);

/** Formats whose pixels may carry an alpha channel. */
export const ALPHA_CAPABLE_MIMES: ReadonlySet<string> = new Set(['image/png', 'image/webp', 'image/avif', 'image/heic']);

function ascii(bytes: Uint8Array, start: number, len: number): string {
  let s = '';
  for (let i = start; i < start + len && i < bytes.length; i++) s += String.fromCharCode(bytes[i]!);
  return s;
}

/** Detect the image type from the first bytes. Never trusts headers or file names. */
export function sniffMime(bytes: Uint8Array): SniffedMime | null {
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'image/jpeg';
  if (
    bytes.length >= 8 &&
    bytes[0] === 0x89 &&
    ascii(bytes, 1, 3) === 'PNG' &&
    bytes[4] === 0x0d &&
    bytes[5] === 0x0a &&
    bytes[6] === 0x1a &&
    bytes[7] === 0x0a
  )
    return 'image/png';
  const gif = ascii(bytes, 0, 6);
  if (gif === 'GIF87a' || gif === 'GIF89a') return 'image/gif';
  if (bytes.length >= 12 && ascii(bytes, 0, 4) === 'RIFF' && ascii(bytes, 8, 4) === 'WEBP') return 'image/webp';
  if (bytes.length >= 12 && ascii(bytes, 4, 4) === 'ftyp') {
    const brand = ascii(bytes, 8, 4);
    if (brand === 'avif' || brand === 'avis') return 'image/avif';
    if (['heic', 'heix', 'heim', 'heis', 'hevc', 'hevx', 'mif1', 'msf1'].includes(brand)) return 'image/heic';
  }
  if (bytes.length >= 2 && bytes[0] === 0x42 && bytes[1] === 0x4d) return 'image/bmp';
  return null;
}

/** True if the bytes contain an EXIF header ("Exif\0\0", as found in JPEG APP1 / WebP EXIF chunks). */
export function containsExif(bytes: Uint8Array): boolean {
  const sig = [0x45, 0x78, 0x69, 0x66, 0x00, 0x00];
  outer: for (let i = 0; i + sig.length <= bytes.length; i++) {
    for (let j = 0; j < sig.length; j++) if (bytes[i + j] !== sig[j]) continue outer;
    return true;
  }
  return false;
}

/** True if any pixel in RGBA data is not fully opaque. */
export function hasTransparentPixel(rgba: ArrayLike<number>): boolean {
  for (let i = 3; i < rgba.length; i += 4) if (rgba[i]! < 255) return true;
  return false;
}
