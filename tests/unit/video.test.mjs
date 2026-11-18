import { test } from 'node:test';
import assert from 'node:assert/strict';
import { videoEmbed } from '../../web/lib/video.js';

test('YouTube links of every shape become privacy-mode embeds with a thumbnail', () => {
  for (const u of ['https://www.youtube.com/watch?v=dQw4w9WgXcQ', 'https://youtu.be/dQw4w9WgXcQ', 'https://youtube.com/shorts/dQw4w9WgXcQ', 'https://m.youtube.com/watch?v=dQw4w9WgXcQ&feature=share']) {
    const e = videoEmbed(u);
    assert.equal(e.provider, 'youtube', u);
    assert.match(e.embedUrl, /^https:\/\/www\.youtube-nocookie\.com\/embed\/dQw4w9WgXcQ\?/);
    assert.equal(e.thumb, 'https://i.ytimg.com/vi/dQw4w9WgXcQ/hqdefault.jpg');
  }
  assert.match(videoEmbed('https://youtu.be/dQw4w9WgXcQ?t=1m30s').embedUrl, /start=90/);
});

test('Vimeo (including unlisted), Hudl and Google Drive embed; short Hudl links and other sites link out', () => {
  assert.equal(videoEmbed('https://vimeo.com/123456789').embedUrl, 'https://player.vimeo.com/video/123456789');
  assert.equal(videoEmbed('https://vimeo.com/123456789/abc123def').embedUrl, 'https://player.vimeo.com/video/123456789?h=abc123def');
  assert.equal(videoEmbed('https://www.hudl.com/video/3/1234567/5f0c1e2d3b4a').embedUrl, 'https://www.hudl.com/embed/video/3/1234567/5f0c1e2d3b4a');
  const short = videoEmbed('https://www.hudl.com/v/2Ab3Cd');
  assert.equal(short.provider, 'hudl'); assert.equal(short.embedUrl, null); assert.equal(short.watchUrl, 'https://www.hudl.com/v/2Ab3Cd');
  assert.equal(videoEmbed('https://drive.google.com/file/d/1AbC_dEf-123/view?usp=sharing').embedUrl, 'https://drive.google.com/file/d/1AbC_dEf-123/preview');
  assert.deepEqual(videoEmbed('https://example.com/film.mp4'), { provider: 'link', embedUrl: null, thumb: null, watchUrl: 'https://example.com/film.mp4' });
  assert.equal(videoEmbed('not a link').provider, 'link');
});
