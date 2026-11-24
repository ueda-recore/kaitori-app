// 外部買取アプリ 試作用 中継サーバー（依存なし / Node 18+）
// APIキーはこのサーバーの環境変数にだけ置く。ブラウザには渡さない。
const http = require('http'), fs = require('fs'), path = require('path');
const BASE = process.env.RECORE_BASE || 'https://co-api.recore-pos.com';
const KEY = process.env.RECORE_API_KEY || '';
const PREFIX = process.env.RECORE_AUTH_PREFIX || ''; // 例: "Bearer "（仕様上は「Authorizationヘッダにキー」。接頭辞の要否は要確認）
const STORE = process.env.RECORE_STORE_ID || '';
const MOCK = process.env.MOCK === '1' || !KEY;
const PORT = process.env.PORT || 3000;

// ---------- モック（キー未設定時） ----------
const db = { members: [], products: [], cases: [], idents: [], seq: 100 };
const nid = () => ++db.seq;
function mock(method, p, q, b) {
  let m;
  if (p === '/me') return [200, { scopes: ['(mock)'] }];
  if (p === '/members' && method === 'GET') {
    const k = q.get('keyword') || '';
    return [200, db.members.filter(x => !k || JSON.stringify(x).includes(k))];
  }
  if (p === '/members' && method === 'POST') { const x = { id: nid(), code: 'M' + db.seq, ...b }; db.members.push(x); return [201, x]; }
  if ((m = p.match(/^\/members\/(\d+)$/)) && method === 'GET') { const x = db.members.find(y => y.id == m[1]); return x ? [200, x] : [404, { message: 'not found' }]; }
  if (p === '/products' && method === 'GET') {
    const t = q.get('title') || '', j = q.get('pa_jan') || '';
    return [200, db.products.filter(x => (!t || x.title.includes(t)) && (!j || (x.attribute || {}).jan === j))];
  }
  if (p === '/products' && method === 'POST') { if (!b.title) return [422, { message: 'title required' }]; const x = { id: nid(), ...b }; db.products.push(x); return [201, x]; }
  if (p === '/products/categories') return [200, [{ id: 1, name: '(mock)衣類', is_leaf: true, ancestors: [] }]];
  if (p === '/v2/bas_cases' && method === 'POST') { const x = { id: nid(), status: 'ASSESSING', ...b, goods: (b.goods || []).map(g => ({ id: nid(), ...g })), attachments: [], txns: [] }; x.summary = { total: x.goods.reduce((s, g) => s + g.quantity * g.unit_price, 0) }; db.cases.push(x); return [201, x]; }
  if ((m = p.match(/^\/v2\/bas_cases\/(\d+)$/)) && method === 'GET') { const x = db.cases.find(y => y.id == m[1]); return x ? [200, x] : [404, { message: 'not found' }]; }
  if ((m = p.match(/^\/v2\/bas_cases\/(\d+)\/status$/)) && method === 'PUT') {
    const x = db.cases.find(y => y.id == m[1]); const ok = { ASSESSING: ['ASSESSED'], ASSESSED: ['CONFIRMED', 'ASSESSING', 'CANCELED'], CONFIRMED: ['CANCELED'] };
    if (!x || !(ok[x.status] || []).includes(b.status)) return [422, { message: `(mock) cannot change ${x && x.status} -> ${b.status}` }];
    x.status = b.status; return [200, x];
  }
  if ((m = p.match(/^\/v2\/bas_cases\/(\d+)\/(txns|attachments)$/)) && method === 'POST') { const x = db.cases.find(y => y.id == m[1]); (x[m[2]] = x[m[2]] || []).push(b); return [201, { id: nid(), ...b }]; }
  if (p === '/identifications' && method === 'POST') { const x = { id: nid(), status: 'IN_PROGRESS', attachments: [], ...b }; db.idents.push(x); return [201, x]; }
  if ((m = p.match(/^\/identifications\/(\d+)\/attachments$/)) && method === 'POST') return [201, { id: nid(), ...b }];
  if ((m = p.match(/^\/identifications\/(\d+)\/status$/)) && method === 'PUT') { const x = db.idents.find(y => y.id == m[1]); if (x) x.status = b.status; return [200, x || {}]; }
  if ((m = p.match(/^\/identifications\/(\d+)$/)) && method === 'GET') { const x = db.idents.find(y => y.id == m[1]); return x ? [200, x] : [404, {}]; }
  return [404, { message: `(mock) not implemented: ${method} ${p}` }];
}

// ---------- 中継 ----------
const headers = extra => ({ 'Content-Type': 'application/json', Authorization: PREFIX + KEY, ...(STORE ? { 'X-Store-Id': STORE } : {}), ...extra });
const readBody = req => new Promise(r => { const c = []; req.on('data', d => c.push(d)); req.on('end', () => r(Buffer.concat(c))); });
const send = (res, status, obj) => { res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' }); res.end(typeof obj === 'string' ? obj : JSON.stringify(obj)); };
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css' };

http.createServer(async (req, res) => {
  const u = new URL(req.url, 'http://x');
  try {
    if (u.pathname === '/_mode') return send(res, 200, { mock: MOCK, base: BASE, storeFixed: !!STORE });
    if (u.pathname === '/_upload' && req.method === 'POST') { // 画像: file_key取得 → 署名URLへPUT をサーバー側で実施
      const kind = u.searchParams.get('kind') === 'public' ? 'public' : 'private', mime = u.searchParams.get('mime') || 'image/jpeg';
      const buf = await readBody(req);
      if (MOCK) return send(res, 200, { file_key: 'mock/' + Date.now(), url: 'mock://' + kind, mime_type: mime, bytes: buf.length });
      const r1 = await fetch(`${BASE}/upload/${kind}`, { method: 'POST', headers: headers(), body: JSON.stringify({ mime_type: mime }) });
      const t1 = await r1.text(); if (!r1.ok) return send(res, r1.status, t1);
      let j = JSON.parse(t1); j = j.data || j;
      const r2 = await fetch(j.url, { method: 'PUT', headers: { 'Content-Type': mime }, body: buf }); // 署名URLは60秒で失効
      if (!r2.ok) return send(res, r2.status, { message: 'PUT failed', body: await r2.text() });
      return send(res, 200, { file_key: j.file_key, url: kind === 'public' ? j.url.split('?')[0] : undefined, mime_type: mime, bytes: buf.length });
    }
    if (u.pathname.startsWith('/api/')) {
      const p = u.pathname.slice(4), body = ['GET', 'DELETE'].includes(req.method) ? '' : (await readBody(req)).toString();
      if (MOCK) { const [s, o] = mock(req.method, p, u.searchParams, body ? JSON.parse(body) : {}); return send(res, s, o); }
      const extra = req.headers['x-store-id'] && !STORE ? { 'X-Store-Id': req.headers['x-store-id'] } : {};
      const hh = headers(extra); if (!body) delete hh['Content-Type']; // ボディなしでContent-Typeを付けると422になる
      const r = await fetch(BASE + p + u.search, { method: req.method, headers: hh, body: body || undefined });
      const t = await r.text(); res.writeHead(r.status, { 'Content-Type': 'application/json; charset=utf-8', 'X-Total-Count': r.headers.get('x-total-count') || '' }); return res.end(t);
    }
    const f = path.join(__dirname, 'public', u.pathname === '/' ? 'index.html' : path.normalize(u.pathname).replace(/^(\.\.[\/\\])+/, ''));
    if (!f.startsWith(path.join(__dirname, 'public')) || !fs.existsSync(f)) return send(res, 404, { message: 'not found' });
    res.writeHead(200, { 'Content-Type': MIME[path.extname(f)] || 'application/octet-stream' }); fs.createReadStream(f).pipe(res);
  } catch (e) { send(res, 500, { message: String(e) }); }
}).listen(PORT, () => console.log(`http://localhost:${PORT}  mode=${MOCK ? 'MOCK（キー未設定）' : 'LIVE → ' + BASE}`));
