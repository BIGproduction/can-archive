// Единый Worker: API каталога (/api/cans) и фото (/img/...). Остальное отдаёт папка public.

async function cans(q, env) {
  if (q.get('meta')) {
    const brands = await env.DB.prepare('SELECT DISTINCT brand v FROM cans WHERE brand IS NOT NULL ORDER BY 1').all();
    const countries = await env.DB.prepare('SELECT DISTINCT country v FROM cans WHERE country IS NOT NULL ORDER BY 1').all();
    const n = await env.DB.prepare('SELECT COUNT(*) n FROM cans').first();
    return Response.json({ brands: brands.results.map(r => r.v), countries: countries.results.map(r => r.v), all: n.n },
      { headers: { 'Cache-Control': 'public, max-age=60' } });
  }
  const where = [], args = [];
  for (const k of ['brand', 'country', 'shape']) if (q.get(k)) { where.push(`${k} = ?`); args.push(q.get(k)); }
  for (const k of ['volume', 'year']) if (q.get(k)) { where.push(`${k} = ?`); args.push(Number(q.get(k))); }
  if (q.get('q')) { where.push('(name LIKE ? OR description LIKE ?)'); args.push(`%${q.get('q')}%`, `%${q.get('q')}%`); }
  const w = where.length ? ' WHERE ' + where.join(' AND ') : '';
  const limit = Math.min(Number(q.get('limit')) || 48, 100), offset = Number(q.get('offset')) || 0;
  const total = await env.DB.prepare('SELECT COUNT(*) n FROM cans' + w).bind(...args).first();
  const rows = await env.DB.prepare('SELECT * FROM cans' + w + ' ORDER BY id DESC LIMIT ? OFFSET ?').bind(...args, limit, offset).all();
  return Response.json({ total: total.n, items: rows.results });
}

let b2 = null; // кэш авторизации Backblaze B2
async function b2Auth(env) {
  if (b2 && b2.exp > Date.now()) return b2;
  const r = await fetch('https://api.backblazeb2.com/b2api/v3/b2_authorize_account', {
    headers: { Authorization: 'Basic ' + btoa(`${env.B2_KEY_ID}:${env.B2_APP_KEY}`) }
  });
  if (!r.ok) throw new Error('B2 auth ' + r.status);
  const j = await r.json();
  b2 = { url: j.apiInfo?.storageApi?.downloadUrl ?? j.downloadUrl, token: j.authorizationToken, exp: Date.now() + 23 * 3600 * 1000 };
  return b2;
}

async function image(request, env, ctx, key) {
  if (!key || key.includes('..')) return new Response('Bad request', { status: 400 });
  const cc = 'public, max-age=31536000, immutable';

  if (env.PHOTOS) { // Cloudflare R2
    const o = await env.PHOTOS.get(key);
    if (!o) return new Response('Not found', { status: 404 });
    return new Response(o.body, { headers: { 'Content-Type': o.httpMetadata?.contentType || 'image/jpeg', 'Cache-Control': cc } });
  }

  // Backblaze B2 (приватный бакет)
  const hit = await caches.default.match(request);
  if (hit) return hit;
  let a;
  try { a = await b2Auth(env); } catch { return new Response('Storage error', { status: 502 }); }
  const res = await fetch(`${a.url}/file/${env.B2_BUCKET}/${encodeURI(key)}`, { headers: { Authorization: a.token } });
  if (res.status === 401) b2 = null;
  if (!res.ok) return new Response('Not found', { status: res.status === 404 ? 404 : 502 });
  const out = new Response(res.body, { headers: { 'Content-Type': res.headers.get('Content-Type') || 'image/jpeg', 'Cache-Control': cc } });
  ctx.waitUntil(caches.default.put(request, out.clone()));
  return out;
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    if (url.pathname === '/api/cans') return cans(url.searchParams, env);
    if (url.pathname.startsWith('/img/')) return image(request, env, ctx, decodeURIComponent(url.pathname.slice(5)));
    return env.ASSETS.fetch(request);
  }
};
