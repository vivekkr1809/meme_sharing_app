import type { CreateMemeServicesOptions, MemeServices } from '../contracts';
import { createImageTools } from './image';
import { createImgflipSource } from './imgflip';
import { makeProxyUrl, RouteMemory } from './net';
import { createRedditSource } from './reddit';

/**
 * Meme sources (Reddit, Imgflip) and on-device image tools.
 *
 * Every network call tries the upstream directly first and falls back to the
 * relay's stateless proxy on network/CORS/403/429 failures; the working route is
 * remembered for the session. Nothing the user creates is ever uploaded: captions
 * are drawn locally on a canvas, and uploads are re-encoded locally.
 */
export function createMemeServices(opts: CreateMemeServicesOptions): MemeServices {
  // Call through a plain function so `fetch` is never invoked with a foreign `this`.
  const fetchImpl: typeof fetch = (input, init) => (opts.fetchImpl ?? globalThis.fetch)(input, init);
  const memory = new RouteMemory();
  const proxyUrl = makeProxyUrl(opts.getRelayUrl);
  return {
    reddit: createRedditSource({ fetchImpl, memory, proxyUrl }),
    imgflip: createImgflipSource({ fetchImpl, memory, proxyUrl }),
    images: createImageTools({ fetchImpl, memory, proxyUrl }),
  };
}

export { MemeError, isMemeError, type MemeErrorCode } from './errors';
export { defaultBoxes, fitText, fitWithin, layoutCaption, wrapText, MAX_DIMENSION, MEME_FONT_STACK } from './layout';
export { parseRedditListing, parseRedditPost } from './reddit';
export { parseImgflipTemplates } from './imgflip';
export { sniffMime } from './sniff';
export { isProxyableImageUrl } from './image';
