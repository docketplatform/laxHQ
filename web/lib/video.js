// Turns a video link (YouTube, Vimeo, Hudl, Google Drive) into something the recruiting card
// can play in place. Pure; unit tested. Unknown sites fall back to a "watch" link.

/**
 * @param {string} url
 * @returns {{ provider: string, embedUrl: string|null, thumb: string|null, watchUrl: string }}
 */
export function videoEmbed(url) {
  let u;
  try { u = new URL(String(url || '').trim()); } catch { return { provider: 'link', embedUrl: null, thumb: null, watchUrl: String(url || '') }; }
  const host = u.hostname.replace(/^www\.|^m\./, '').toLowerCase();
  const watchUrl = u.toString();
  const seconds = (t) => {
    if (!t) return 0;
    if (/^\d+$/.test(t)) return Number(t);
    const m = /^(?:(\d+)h)?(?:(\d+)m)?(?:(\d+)s)?$/.exec(t);
    return m ? (Number(m[1] || 0) * 3600) + (Number(m[2] || 0) * 60) + Number(m[3] || 0) : 0;
  };

  // YouTube: watch?v=, youtu.be/, /shorts/, /embed/, /live/
  let yt = null;
  if (host === 'youtu.be') yt = u.pathname.slice(1).split('/')[0];
  else if (host.endsWith('youtube.com') || host === 'youtube-nocookie.com') {
    yt = u.searchParams.get('v') || (/^\/(?:shorts|embed|live)\/([^/?#]+)/.exec(u.pathname) || [])[1] || null;
  }
  if (yt && /^[A-Za-z0-9_-]{6,20}$/.test(yt)) {
    const start = seconds(u.searchParams.get('t') || u.searchParams.get('start'));
    return {
      provider: 'youtube',
      embedUrl: `https://www.youtube-nocookie.com/embed/${yt}?rel=0&modestbranding=1&playsinline=1${start ? `&start=${start}` : ''}`,
      thumb: `https://i.ytimg.com/vi/${yt}/hqdefault.jpg`,
      watchUrl,
    };
  }

  // Vimeo: vimeo.com/123456 or vimeo.com/123456/abcdef (unlisted hash)
  if (host === 'vimeo.com' || host === 'player.vimeo.com') {
    const m = /^\/(?:video\/)?(\d+)(?:\/([a-f0-9]+))?/.exec(u.pathname);
    if (m) {
      const h = m[2] || u.searchParams.get('h');
      return { provider: 'vimeo', embedUrl: `https://player.vimeo.com/video/${m[1]}${h ? `?h=${h}` : ''}`, thumb: null, watchUrl };
    }
  }

  // Hudl: hudl.com/video/3/<athlete>/<video> (also /embed/video/...). Short hudl.com/v/... links can't be embedded.
  if (host === 'hudl.com') {
    const m = /^\/(?:embed\/)?video\/(\d+)\/(\d+)\/([A-Za-z0-9]+)/.exec(u.pathname);
    if (m) return { provider: 'hudl', embedUrl: `https://www.hudl.com/embed/video/${m[1]}/${m[2]}/${m[3]}`, thumb: null, watchUrl };
    return { provider: 'hudl', embedUrl: null, thumb: null, watchUrl };
  }

  // Google Drive: drive.google.com/file/d/<id>/view
  if (host === 'drive.google.com') {
    const m = /^\/file\/d\/([A-Za-z0-9_-]+)/.exec(u.pathname);
    if (m) return { provider: 'drive', embedUrl: `https://drive.google.com/file/d/${m[1]}/preview`, thumb: null, watchUrl };
  }

  return { provider: 'link', embedUrl: null, thumb: null, watchUrl };
}

export const PROVIDER_LABEL = { youtube: 'YouTube', vimeo: 'Vimeo', hudl: 'Hudl', drive: 'Google Drive', link: 'the video site' };
export const VIDEO_KINDS = [
  { value: 'highlight', label: 'Highlight reel' }, { value: 'game', label: 'Full game' },
  { value: 'skills', label: 'Skills video' }, { value: 'other', label: 'Other' },
];
