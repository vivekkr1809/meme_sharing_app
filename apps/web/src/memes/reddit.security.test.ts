import { describe, expect, it } from 'vitest';
import { redditUrl } from '../ui/format';
import { parseImgflipTemplates } from './imgflip';
import { parseRedditPost, safeRedditLink } from './reddit';

/** Security review (A7): Reddit JSON is untrusted web content. */

const post = (over: Record<string, unknown> = {}) => ({
  id: 'abc123',
  title: 'hi',
  subreddit: 'memes',
  author: 'someone',
  score: 1,
  created_utc: 1,
  post_hint: 'image',
  url: 'https://i.redd.it/abc.jpg',
  permalink: '/r/memes/comments/abc123/hi/',
  ...over,
});

describe('Reddit permalinks', () => {
  it('cannot point the "View on Reddit" link at another host', () => {
    for (const permalink of ['@evil.example/phish', '//evil.example/x', 'https://evil.example/x', 'javascript:alert(1)', 'https://www.reddit.com:8443/x']) {
      const p = parseRedditPost(post({ permalink }))!;
      expect(new URL(p.permalink).hostname, permalink).toBe('www.reddit.com');
      expect(p.permalink.startsWith('https://www.reddit.com/')).toBe(true);
    }
    expect(parseRedditPost(post())!.permalink).toBe('https://www.reddit.com/r/memes/comments/abc123/hi/');
  });

  it('redditUrl() only ever returns an https Reddit URL', () => {
    expect(redditUrl('https://www.reddit.com@evil.example/x')).toBe('https://www.reddit.com/');
    expect(redditUrl('javascript:alert(1)')).toBe('https://www.reddit.com/');
    expect(redditUrl('data:text/html,<script>1</script>')).toBe('https://www.reddit.com/');
    expect(redditUrl('//evil.example')).toBe('https://www.reddit.com/');
    expect(redditUrl('/r/memes/comments/x/')).toBe('https://www.reddit.com/r/memes/comments/x/');
    expect(safeRedditLink('https://user:pw@www.reddit.com/')).toBeUndefined();
  });
});

describe('Reddit image hosts', () => {
  it('drops posts whose image is on an unknown host (IP leak, blocked by CSP anyway)', () => {
    expect(parseRedditPost(post({ url: 'https://tracker.example/meme.jpg' }))).toBeNull();
    expect(parseRedditPost(post({ url: 'https://i.redd.it.evil.example/abc.jpg' }))).toBeNull();
    expect(parseRedditPost(post({ url: 'http://i.redd.it/abc.jpg' }))!.imageUrl).toBe('https://i.redd.it/abc.jpg');
  });

  it('drops a thumbnail on an unknown host but keeps the post', () => {
    const p = parseRedditPost(
      post({ preview: { images: [{ source: { url: 'https://tracker.example/t.jpg', width: 640, height: 640 }, resolutions: [] }] } }),
    )!;
    expect(p.imageUrl).toBe('https://i.redd.it/abc.jpg');
    expect(p.thumbUrl).toBeUndefined();
  });
});

describe('Imgflip templates', () => {
  it('only accepts template images from i.imgflip.com', () => {
    const t = (url: string) => ({ id: '1', name: 'Drake', url, width: 10, height: 10, box_count: 2 });
    const parse = (url: string) => parseImgflipTemplates({ success: true, data: { memes: [t(url)] } });
    expect(parse('https://i.imgflip.com/30b1gx.jpg')[0]!.url).toBe('https://i.imgflip.com/30b1gx.jpg');
    expect(parse('http://i.imgflip.com/30b1gx.jpg')[0]!.url).toBe('https://i.imgflip.com/30b1gx.jpg');
    expect(parse('https://tracker.example/x.jpg')).toEqual([]);
    expect(parse('javascript:alert(1)')).toEqual([]);
    expect(parse('https://i.imgflip.com@evil.example/x.jpg')).toEqual([]);
  });
});
