// Worker: каталог (/api/cans), регистрация и вход, публикация банок, фото из R2 (/img/...)
const BRANDS = ['Monster', 'Red Bull', 'Coca-Cola', 'Pepsi', 'Schweppes', 'Fanta'];
const TYPES = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp' };
const MAX_FILE = 8 * 1024 * 1024;
const enc = new TextEncoder();
const hex = b => [...new Uint8Array(b)].map(x => x.toString(16).padStart(2, '0')).join('');
const unhex = h => new Uint8Array(h.match(/../g).map(x => parseInt(x, 16)));
const json = (o, status = 200, headers = {}) => Response.json(o, { status, headers });

async function pbkdf2(password, salt) {
  const key = await crypto.subtle.importKey('raw', enc.encode(password), 'PBKDF2', false, ['deriveBits']);
  return hex(await crypto.subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt, iterations: 100000 }, key, 256));
}
const sha = async s => hex(await crypto.subtle.digest('SHA-256', enc.encode(s)));

function sid(request) {
  const m = (request.headers.get('Cookie') || '').match(/(?:^|; )sid=([0-9a-f]+)/);
  return m && m[1];
}
async function currentUser(request, env) {
  const t = sid(request);
  if (!t) return null;
  return env.DB.prepare('SELECT u.id, u.nick FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.token_hash = ? AND s.expires > ?')
    .bind(await sha(t), Date.now()).first();
}
async function startSession(env, userId) {
  const t = hex(crypto.getRandomValues(new Uint8Array(32)));
  await env.DB.prepare('INSERT INTO sessions (token_hash, user_id, expires) VALUES (?, ?, ?)')
    .bind(await sha(t), userId, Date.now() + 30 * 864e5).run();
  return `sid=${t}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=2592000`;
}

async function register(request, env) {
  const { nick, password } = await request.json().catch(() => ({}));
  if (!/^[\p{L}\p{N}_-]{3,20}$/u.test(nick || '')) return json({ error: 'Nickname: 3–20 characters (letters, digits, _ and -)' }, 400);
  if (typeof password !== 'string' || password.length < 8 || password.length > 100) return json({ error: 'Password: at least 8 characters' }, 400);
  const salt = crypto.getRandomValues(new Uint8Array(16));
  try {
    const r = await env.DB.prepare('INSERT INTO users (nick, nick_lc, salt, hash, created) VALUES (?, ?, ?, ?, ?)')
      .bind(nick, nick.toLowerCase(), hex(salt), await pbkdf2(password, salt), Date.now()).run();
    return json({ nick }, 200, { 'Set-Cookie': await startSession(env, r.meta.last_row_id) });
  } catch (e) {
    if (/UNIQUE/i.test(String(e && e.message || e))) return json({ error: 'This nickname is already taken' }, 409);
    throw e;
  }
}

async function login(request, env) {
  const { nick, password } = await request.json().catch(() => ({}));
  const u = await env.DB.prepare('SELECT * FROM users WHERE nick_lc = ?').bind(String(nick || '').toLowerCase()).first();
  if (!u || (await pbkdf2(String(password || ''), unhex(u.salt))) !== u.hash) return json({ error: 'Wrong nickname or password' }, 401);
  return json({ nick: u.nick }, 200, { 'Set-Cookie': await startSession(env, u.id) });
}

async function logout(request, env) {
  const t = sid(request);
  if (t) await env.DB.prepare('DELETE FROM sessions WHERE token_hash = ?').bind(await sha(t)).run();
  return json({ ok: true }, 200, { 'Set-Cookie': 'sid=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0' });
}

async function cans(q, env) {
  if (q.get('meta')) {
    const c = await env.DB.prepare('SELECT brand, COUNT(*) n FROM cans GROUP BY brand').all();
    const countries = await env.DB.prepare('SELECT DISTINCT country v FROM cans WHERE country IS NOT NULL ORDER BY 1').all();
    const n = await env.DB.prepare('SELECT COUNT(*) n FROM cans').first();
    const vols = await env.DB.prepare('SELECT DISTINCT volume v FROM cans WHERE volume IS NOT NULL ORDER BY 1').all();
    const yrs = await env.DB.prepare('SELECT DISTINCT year v FROM cans WHERE year IS NOT NULL ORDER BY 1 DESC').all();
    const cv = await env.DB.prepare('SELECT brand, k FROM (SELECT brand, COALESCE(cover, photo) AS k, ROW_NUMBER() OVER (PARTITION BY brand ORDER BY id DESC) rn FROM cans WHERE COALESCE(cover, photo) IS NOT NULL) WHERE rn <= 9').all();
    const covers = {};
    for (const r of cv.results) (covers[r.brand] ||= []).push(r.k);
    return json({
      brands: BRANDS,
      counts: Object.fromEntries(c.results.map(r => [r.brand, r.n])),
      countries: countries.results.map(r => r.v),
      volumes: vols.results.map(r => r.v),
      years: yrs.results.map(r => r.v),
      covers,
      all: n.n
    });
  }
  const where = [], args = [];
  for (const k of ['brand', 'country', 'shape']) if (q.get(k)) { where.push(`${k} = ?`); args.push(q.get(k)); }
  for (const k of ['volume', 'year', 'series_id']) if (q.get(k)) { where.push(`${k} = ?`); args.push(Number(q.get(k))); }
  if (q.get('q')) { where.push('(name LIKE ? OR description LIKE ?)'); args.push(`%${q.get('q')}%`, `%${q.get('q')}%`); }
  const w = where.length ? ' WHERE ' + where.join(' AND ') : '';
  const limit = Math.min(Number(q.get('limit')) || 48, 100), offset = Number(q.get('offset')) || 0;
  const total = await env.DB.prepare('SELECT COUNT(*) n FROM cans' + w).bind(...args).first();
  const rows = await env.DB.prepare('SELECT c.*, u.nick AS author FROM cans c LEFT JOIN users u ON u.id = c.user_id' + w + ' ORDER BY c.id DESC LIMIT ? OFFSET ?')
    .bind(...args, limit, offset).all();
  return json({ total: total.n, items: rows.results });
}

async function publish(request, env) {
  const user = await currentUser(request, env);
  if (!user) return json({ error: 'Please log in or sign up first' }, 401);
  if (!env.PHOTOS) return json({ error: 'Photo storage is not connected' }, 501);

  const f = await request.formData().catch(() => null);
  if (!f) return json({ error: 'Invalid data' }, 400);
  const brand = f.get('brand'), shape = f.get('shape');
  const name = String(f.get('name') || '').trim(), country = String(f.get('country') || '').trim();
  const description = String(f.get('description') || '').trim();
  const volume = Number(f.get('volume')), year = Number(f.get('year'));
  const photo = f.get('photo'), cover = f.get('cover');
  const seriesId = Number(f.get('series_id'));

  if (!BRANDS.includes(brand)) return json({ error: 'Select a brand' }, 400);
  const ser = await env.DB.prepare('SELECT id FROM series WHERE id = ? AND brand = ?').bind(seriesId, brand).first();
  if (!ser) return json({ error: 'Select a flavor/series folder' }, 400);
  if (!name || name.length > 120) return json({ error: 'Enter a name (up to 120 characters)' }, 400);
  if (!country || country.length > 60) return json({ error: 'Enter a country' }, 400);
  if (!Number.isInteger(volume) || volume < 1 || volume > 5000) return json({ error: 'Volume: a number from 1 to 5000 ml' }, 400);
  if (!Number.isInteger(year) || year < 1900 || year > 2100) return json({ error: 'Enter a year' }, 400);
  if (!['slim', 'wide'].includes(shape)) return json({ error: 'Select a can shape' }, 400);
  if (description.length > 2000) return json({ error: 'Description is too long' }, 400);

  const okFile = x => x && typeof x === 'object' && TYPES[x.type] && x.size > 0 && x.size <= MAX_FILE;
  if (!okFile(photo)) return json({ error: 'Photo: JPG, PNG or WebP, up to 8 MB' }, 400);
  if (cover && cover.size && !okFile(cover)) return json({ error: 'Cover: JPG, PNG or WebP, up to 8 MB' }, 400);

  const r = await env.DB.prepare('INSERT INTO cans (name, brand, country, volume, year, shape, description, user_id, series_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)')
    .bind(name, brand, country, volume, year, shape, description, user.id, seriesId).run();
  const id = r.meta.last_row_id;
  try {
    const photoKey = `cans/${id}.${TYPES[photo.type]}`;
    await env.PHOTOS.put(photoKey, photo.stream(), { httpMetadata: { contentType: photo.type } });
    let coverKey = photoKey; // без отдельной обложки в каталоге показывается само фото
    if (cover && cover.size) {
      coverKey = `cans/${id}-cover.${TYPES[cover.type]}`;
      await env.PHOTOS.put(coverKey, cover.stream(), { httpMetadata: { contentType: cover.type } });
    }
    await env.DB.prepare('UPDATE cans SET photo = ?, cover = ? WHERE id = ?').bind(photoKey, coverKey, id).run();
  } catch {
    await env.DB.prepare('DELETE FROM cans WHERE id = ?').bind(id).run();
    return json({ error: 'Could not save the photo, please try again' }, 500);
  }
  return json({ id });
}

async function seriesList(q, env) {
  if (q.get('id')) {
    const s = await env.DB.prepare('SELECT id, brand, name FROM series WHERE id = ?').bind(Number(q.get('id'))).first();
    return s ? json(s) : json({ error: 'Folder not found' }, 404);
  }
  const brand = q.get('brand') || '';
  const rows = await env.DB.prepare('SELECT id, name FROM series WHERE brand = ? ORDER BY name').bind(brand).all();
  const cv = await env.DB.prepare('SELECT series_id, k FROM (SELECT series_id, COALESCE(cover, photo) AS k, ROW_NUMBER() OVER (PARTITION BY series_id ORDER BY id DESC) rn FROM cans WHERE brand = ? AND series_id IS NOT NULL AND COALESCE(cover, photo) IS NOT NULL) WHERE rn <= 4').bind(brand).all();
  const by = {};
  for (const r of cv.results) (by[r.series_id] ||= []).push(r.k);
  return json({ items: rows.results.map(r => ({ ...r, covers: by[r.id] || [] })) });
}

async function seriesCreate(request, env) {
  const user = await currentUser(request, env);
  if (!user) return json({ error: 'Please log in or sign up first' }, 401);
  const { brand, name } = await request.json().catch(() => ({}));
  const n = String(name || '').trim();
  if (!BRANDS.includes(brand)) return json({ error: 'Select a brand' }, 400);
  if (!n || n.length > 60) return json({ error: 'Folder name: 1 to 60 characters' }, 400);
  try {
    const r = await env.DB.prepare('INSERT INTO series (brand, name, name_lc, user_id, created) VALUES (?, ?, ?, ?, ?)')
      .bind(brand, n, n.toLowerCase(), user.id, Date.now()).run();
    return json({ id: r.meta.last_row_id });
  } catch (e) {
    if (/UNIQUE/i.test(String(e && e.message || e))) return json({ error: 'This folder already exists in this brand' }, 409);
    throw e;
  }
}

const NEED_LOGIN = { error: 'Please log in or sign up first' };

async function profileGet(request, env) {
  const u = await currentUser(request, env);
  if (!u) return json(NEED_LOGIN, 401);
  const row = await env.DB.prepare('SELECT avatar, start_year, countries FROM users WHERE id = ?').bind(u.id).first();
  const owned = await env.DB.prepare("SELECT COUNT(*) n FROM user_cans WHERE user_id = ? AND kind = 'owned'").bind(u.id).first();
  const brands = await env.DB.prepare("SELECT c.brand AS brand, COUNT(*) AS n FROM user_cans uc JOIN cans c ON c.id = uc.can_id WHERE uc.user_id = ? AND uc.kind = 'owned' GROUP BY c.brand ORDER BY n DESC, c.brand").bind(u.id).all();
  let countries = [];
  try { countries = JSON.parse(row.countries || '[]'); } catch {}
  return json({ nick: u.nick, avatar: row.avatar, start_year: row.start_year, countries, owned: owned.n, brands: brands.results });
}

async function profileSave(request, env) {
  const u = await currentUser(request, env);
  if (!u) return json(NEED_LOGIN, 401);
  const b = await request.json().catch(() => ({}));
  if ('start_year' in b) {
    const y = b.start_year === null || b.start_year === '' ? null : Number(b.start_year);
    if (y !== null && (!Number.isInteger(y) || y < 1900 || y > 2100)) return json({ error: 'Year: a number from 1900 to 2100' }, 400);
    await env.DB.prepare('UPDATE users SET start_year = ? WHERE id = ?').bind(y, u.id).run();
  }
  if ('countries' in b) {
    const c = b.countries;
    if (!Array.isArray(c) || c.length > 300 || !c.every(x => typeof x === 'string' && /^[\p{L}\p{N} :.'()-]{1,40}$/u.test(x))) return json({ error: 'Invalid country list' }, 400);
    await env.DB.prepare('UPDATE users SET countries = ? WHERE id = ?').bind(JSON.stringify([...new Set(c)]), u.id).run();
  }
  return json({ ok: true });
}

async function avatarSet(request, env) {
  const u = await currentUser(request, env);
  if (!u) return json(NEED_LOGIN, 401);
  if (!env.PHOTOS) return json({ error: 'Photo storage is not connected' }, 501);
  const f = await request.formData().catch(() => null);
  const file = f && f.get('file');
  if (!file || typeof file !== 'object' || !TYPES[file.type] || !file.size || file.size > 5 * 1024 * 1024) return json({ error: 'Photo: JPG, PNG or WebP, up to 5 MB' }, 400);
  const key = `avatars/${u.id}-${Date.now()}.${TYPES[file.type]}`;
  await env.PHOTOS.put(key, file.stream(), { httpMetadata: { contentType: file.type } });
  const old = await env.DB.prepare('SELECT avatar FROM users WHERE id = ?').bind(u.id).first();
  await env.DB.prepare('UPDATE users SET avatar = ? WHERE id = ?').bind(key, u.id).run();
  if (old && old.avatar) await env.PHOTOS.delete(old.avatar);
  return json({ avatar: key });
}

async function avatarDelete(request, env) {
  const u = await currentUser(request, env);
  if (!u) return json(NEED_LOGIN, 401);
  const old = await env.DB.prepare('SELECT avatar FROM users WHERE id = ?').bind(u.id).first();
  await env.DB.prepare('UPDATE users SET avatar = NULL WHERE id = ?').bind(u.id).run();
  if (old && old.avatar && env.PHOTOS) await env.PHOTOS.delete(old.avatar);
  return json({ ok: true });
}

async function collectionGet(request, env) {
  const u = await currentUser(request, env);
  if (!u) return json(NEED_LOGIN, 401);
  const rows = await env.DB.prepare('SELECT can_id, kind FROM user_cans WHERE user_id = ?').bind(u.id).all();
  return json({
    owned: rows.results.filter(r => r.kind === 'owned').map(r => r.can_id),
    wish: rows.results.filter(r => r.kind === 'wish').map(r => r.can_id)
  });
}

async function collectionSet(request, env) {
  const u = await currentUser(request, env);
  if (!u) return json(NEED_LOGIN, 401);
  const { id, kind, on } = await request.json().catch(() => ({}));
  if (!['owned', 'wish'].includes(kind) || !Number.isInteger(id)) return json({ error: 'Invalid data' }, 400);
  if (on) {
    const can = await env.DB.prepare('SELECT id FROM cans WHERE id = ?').bind(id).first();
    if (!can) return json({ error: 'Can not found' }, 404);
    await env.DB.prepare('INSERT OR IGNORE INTO user_cans (user_id, can_id, kind) VALUES (?, ?, ?)').bind(u.id, id, kind).run();
  } else {
    await env.DB.prepare('DELETE FROM user_cans WHERE user_id = ? AND can_id = ? AND kind = ?').bind(u.id, id, kind).run();
  }
  return json({ ok: true });
}

async function image(env, key) {
  if (!key || key.includes('..')) return new Response('Bad request', { status: 400 });
  const o = await env.PHOTOS.get(key);
  if (!o) return new Response('Not found', { status: 404 });
  return new Response(o.body, { headers: { 'Content-Type': o.httpMetadata?.contentType || 'image/jpeg', 'Cache-Control': 'public, max-age=31536000, immutable' } });
}

async function handle(request, env) {
    const url = new URL(request.url), p = url.pathname, m = request.method;
    if (m !== 'GET' && m !== 'HEAD') {
      const o = request.headers.get('Origin');
      if (o && o !== url.origin) return json({ error: 'Forbidden' }, 403);
    }
    if (p === '/api/cans') return m === 'POST' ? publish(request, env) : cans(url.searchParams, env);
    if (p === '/api/profile') return m === 'POST' ? profileSave(request, env) : profileGet(request, env);
    if (p === '/api/avatar') return m === 'POST' ? avatarSet(request, env) : m === 'DELETE' ? avatarDelete(request, env) : json({ error: 'Method not allowed' }, 405);
    if (p === '/api/collection') return m === 'POST' ? collectionSet(request, env) : collectionGet(request, env);
    if (p === '/api/series') return m === 'POST' ? seriesCreate(request, env) : seriesList(url.searchParams, env);
    if (p === '/api/me') { const u = await currentUser(request, env); return json({ nick: u ? u.nick : null }); }
    if (p === '/api/register' && m === 'POST') return register(request, env);
    if (p === '/api/login' && m === 'POST') return login(request, env);
    if (p === '/api/logout' && m === 'POST') return logout(request, env);
    if (p.startsWith('/img/')) return image(env, decodeURIComponent(p.slice(5)));
    return env.ASSETS.fetch(request);
}

export default {
  async fetch(request, env) {
    try { return await handle(request, env); }
    catch (e) { return json({ error: 'Server error: ' + (e && e.message || e) }, 500); }
  }
};
