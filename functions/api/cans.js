export async function onRequestGet({ request, env }) {
  const q = new URL(request.url).searchParams;

  // Списки для фильтров и общий счётчик «банок в архиве»
  if (q.get('meta')) {
    const brands = await env.DB.prepare('SELECT DISTINCT brand v FROM cans WHERE brand IS NOT NULL ORDER BY 1').all();
    const countries = await env.DB.prepare('SELECT DISTINCT country v FROM cans WHERE country IS NOT NULL ORDER BY 1').all();
    const n = await env.DB.prepare('SELECT COUNT(*) n FROM cans').first();
    return Response.json(
      { brands: brands.results.map(r => r.v), countries: countries.results.map(r => r.v), all: n.n },
      { headers: { 'Cache-Control': 'public, max-age=60' } }
    );
  }

  const where = [], args = [];
  // Имена колонок берутся только из этого фиксированного списка
  for (const k of ['brand', 'country', 'shape']) if (q.get(k)) { where.push(`${k} = ?`); args.push(q.get(k)); }
  for (const k of ['volume', 'year']) if (q.get(k)) { where.push(`${k} = ?`); args.push(Number(q.get(k))); }
  if (q.get('q')) { where.push('(name LIKE ? OR description LIKE ?)'); args.push(`%${q.get('q')}%`, `%${q.get('q')}%`); }

  const w = where.length ? ' WHERE ' + where.join(' AND ') : '';
  const limit = Math.min(Number(q.get('limit')) || 48, 100);
  const offset = Number(q.get('offset')) || 0;

  const total = await env.DB.prepare('SELECT COUNT(*) n FROM cans' + w).bind(...args).first();
  const rows = await env.DB.prepare('SELECT * FROM cans' + w + ' ORDER BY id DESC LIMIT ? OFFSET ?')
    .bind(...args, limit, offset).all();

  return Response.json({ total: total.n, items: rows.results });
}
