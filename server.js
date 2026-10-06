const http = require('node:http');
const fs = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');

const ROOT = __dirname;
const DATA = process.env.DATA_DIR ? path.resolve(process.env.DATA_DIR) : path.join(ROOT, 'data');
const FILES = { '/': 'index.html', '/index.html': 'index.html', '/catalog': 'index.html', '/styles.css': 'styles.css', '/storefront.js': 'storefront.js', '/account.js': 'account.js', '/profile': 'profile.html', '/profile.html': 'profile.html', '/profile.js': 'profile.js', '/admin': 'admin.html', '/admin.html': 'admin.html', '/admin.js': 'admin.js', '/admin.css': 'admin.css' };
const USER = process.env.ADMIN_USER || 'admin';
const PASS = process.env.ADMIN_PASSWORD || 'admin';
const HOST = process.env.HOST || '127.0.0.1';
const SECURE_COOKIE = process.env.SECURE_COOKIE === 'true';
if (!['127.0.0.1', 'localhost', '::1'].includes(HOST) && PASS === 'admin') {
  console.error('Refusing to expose the default admin/admin password. Set ADMIN_PASSWORD before binding to a public interface.');
  process.exit(1);
}
if (!['127.0.0.1', 'localhost', '::1'].includes(HOST) && !SECURE_COOKIE) {
  console.error('Refusing a public bind without SECURE_COOKIE=true. Put this app behind HTTPS.');
  process.exit(1);
}
const sessions = new Map();
const accountSessions = new Map();
const cookieSecure = SECURE_COOKIE ? '; Secure' : '';
const contentTypes = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8' };
async function readList(file, fallback = []) {
  try { return JSON.parse((await fs.readFile(path.join(DATA, file), 'utf8')).replace(/^\uFEFF/, '')); }
  catch (err) { if (err.code !== 'ENOENT') throw err; return fallback; }
}
async function writeList(file, list) {
  const target = path.join(DATA, file), temp = target + '.tmp';
  await fs.writeFile(temp, JSON.stringify(list, null, 2), 'utf8');
  await fs.rename(temp, target);
}
// Serialize inventory-changing operations so simultaneous orders cannot sell
// the same last unit before either request has written its updated stock.
let inventoryQueue = Promise.resolve();
function withInventoryLock(operation) {
  const result = inventoryQueue.then(operation, operation);
  inventoryQueue = result.catch(() => {});
  return result;
}
async function body(req) {
  let raw = '';
  for await (const chunk of req) { raw += chunk; if (raw.length > 1024 * 1024) throw Object.assign(new Error('Request too large'), { status: 413 }); }
  return raw ? JSON.parse(raw) : {};
}
function send(res, status, value, headers = {}) {
  const data = typeof value === 'string' ? value : JSON.stringify(value);
  res.writeHead(status, { 'Content-Type': typeof value === 'string' ? 'text/plain; charset=utf-8' : 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', ...headers });
  res.end(data);
}
function cookie(req, key) {
  const part = (req.headers.cookie || '').split(';').map(x => x.trim()).find(x => x.startsWith(key + '='));
  return part ? decodeURIComponent(part.slice(key.length + 1)) : '';
}
function authenticated(req) {
  const id = cookie(req, 'hipos_session'), expires = sessions.get(id);
  if (!id || !expires || expires < Date.now()) { sessions.delete(id); return false; }
  sessions.set(id, Date.now() + 8 * 60 * 60 * 1000);
  return true;
}
function currentAccount(req) {
  const id = cookie(req, 'hipos_account'), accountId = accountSessions.get(id);
  if (!id || !accountId) return null;
  const expiry = sessions.get('account:' + id);
  if (!expiry || expiry < Date.now()) { accountSessions.delete(id); sessions.delete('account:' + id); return null; }
  sessions.set('account:' + id, Date.now() + 30 * 24 * 60 * 60 * 1000);
  return accountId;
}
function accountCookie(id, maxAge = 2592000) {
  return { 'Set-Cookie': 'hipos_account=' + id + '; HttpOnly; SameSite=Lax; Path=/; Max-Age=' + maxAge + cookieSecure };
}
function cleanProduct(input, old = {}) {
  const str = (v, max = 800) => String(v ?? '').trim().slice(0, max);
  const price = Number(input.price), stock = Number(input.stock);
  const images = Array.isArray(input.images) ? input.images.map(x => str(x, 2000)).filter(x => /^https?:\/\//i.test(x)).slice(0, 8) : [];
  const colors = Array.isArray(input.colors) ? input.colors.map(x => str(x, 60)).filter(Boolean).slice(0, 12) : [];
  if (!str(input.title, 160) || !Number.isFinite(price) || price < 0 || !Number.isInteger(stock) || stock < 0 || !images.length) {
    throw Object.assign(new Error('Укажите название, цену, целое количество и хотя бы одно фото по ссылке.'), { status: 400 });
  }
  return { id: old.id || str(input.id, 80) || 'p-' + crypto.randomUUID().slice(0, 8), title: str(input.title, 160), brand: str(input.brand, 100), category: str(input.category, 100), description: str(input.description, 3000), price, oldPrice: input.oldPrice === '' || input.oldPrice == null ? null : Math.max(0, Number(input.oldPrice) || 0), stock, rating: null, badge: str(input.badge, 40), colors, images, supplierUrl: /^https?:\/\//i.test(str(input.supplierUrl, 2000)) ? str(input.supplierUrl, 2000) : '', active: input.active !== false };
}
async function handle(req, res) {
  const url = new URL(req.url, 'http://localhost');
  try {
    if (url.pathname === '/api/account/register' && req.method === 'POST') {
      const input = await body(req), name = String(input.name || '').trim().slice(0, 100), email = String(input.email || '').trim().toLowerCase().slice(0, 254), password = String(input.password || '');
      if (name.length < 2 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || password.length < 8 || password.length > 200) return send(res, 400, { error: 'Укажите имя, корректную почту и пароль не короче 8 символов.' });
      const users = await readList('users.json');
      if (users.some(x => x.email === email)) return send(res, 409, { error: 'Аккаунт с такой почтой уже существует.' });
      const salt = crypto.randomBytes(16).toString('hex'), passwordHash = await new Promise((resolve, reject) => crypto.scrypt(password, salt, 64, (err, key) => err ? reject(err) : resolve(key.toString('hex'))));
      const user = { id: 'u-' + crypto.randomUUID(), name, email, salt, passwordHash, createdAt: new Date().toISOString() };
      users.push(user); await writeList('users.json', users);
      const sid = crypto.randomBytes(32).toString('hex'); accountSessions.set(sid, user.id); sessions.set('account:' + sid, Date.now() + 30 * 86400000);
      return send(res, 201, { user: { name, email } }, accountCookie(sid));
    }
    if (url.pathname === '/api/account/login' && req.method === 'POST') {
      const input = await body(req), email = String(input.email || '').trim().toLowerCase(), password = String(input.password || ''), users = await readList('users.json'), user = users.find(x => x.email === email);
      if (!user) return send(res, 401, { error: 'Неверная почта или пароль.' });
      const hash = await new Promise((resolve, reject) => crypto.scrypt(password, user.salt, 64, (err, key) => err ? reject(err) : resolve(key)));
      if (!crypto.timingSafeEqual(hash, Buffer.from(user.passwordHash, 'hex'))) return send(res, 401, { error: 'Неверная почта или пароль.' });
      const sid = crypto.randomBytes(32).toString('hex'); accountSessions.set(sid, user.id); sessions.set('account:' + sid, Date.now() + 30 * 86400000);
      return send(res, 200, { user: { name: user.name, email: user.email } }, accountCookie(sid));
    }
    if (url.pathname === '/api/account/logout' && req.method === 'POST') {
      const sid = cookie(req, 'hipos_account'); accountSessions.delete(sid); sessions.delete('account:' + sid);
      return send(res, 200, { ok: true }, accountCookie('', 0));
    }
    if (url.pathname === '/api/account/me' && req.method === 'GET') {
      const id = currentAccount(req); if (!id) return send(res, 401, { error: 'Войдите в аккаунт.' });
      const users = await readList('users.json'), user = users.find(x => x.id === id);
      return user ? send(res, 200, { name: user.name, email: user.email }) : send(res, 401, { error: 'Аккаунт не найден.' });
    }
    if (url.pathname === '/api/account/orders' && req.method === 'GET') {
      const id = currentAccount(req); if (!id) return send(res, 401, { error: 'Войдите в аккаунт.' });
      return send(res, 200, (await readList('orders.json')).filter(x => x.customerId === id).map(({ customerId, ...order }) => order));
    }
    if (url.pathname === '/health' && req.method === 'GET') return send(res, 200, { status: 'ok' });
    if (url.pathname === '/api/catalog' && req.method === 'GET') {
      return send(res, 200, (await readList('products.json')).filter(x => x.active !== false));
    }
    if (url.pathname === '/api/orders' && req.method === 'POST') {
      const input = await body(req);
      return await withInventoryLock(async () => {
        const products = await readList('products.json');
        const items = Array.isArray(input.items) ? input.items : [];
        if (!items.length || items.length > 40) return send(res, 400, { error: 'Корзина пуста или содержит слишком много товаров.' });
        const requested = new Map();
        for (const item of items) {
          const qty = Number(item.qty);
          if (!Number.isInteger(qty) || qty < 1 || qty > 20) return send(res, 400, { error: 'Некорректное количество товара.' });
          const combined = (requested.get(item.id) || 0) + qty;
          if (combined > 20) return send(res, 400, { error: 'За один раз можно заказать не больше 20 штук одного товара.' });
          requested.set(item.id, combined);
        }
        const lines = [];
        for (const [id, qty] of requested) {
          const p = products.find(x => x.id === id && x.active !== false);
          if (!p || qty > p.stock) return send(res, 400, { error: 'Изменилось наличие товара. Обновите корзину и попробуйте снова.' });
          lines.push({ id: p.id, title: p.title, qty, price: p.price, color: String(items.find(x => x.id === id)?.color || '').slice(0, 60), supplierUrl: p.supplierUrl || '' });
        }
        const name = String(input.customer?.name || '').trim().slice(0, 120), phone = String(input.customer?.phone || '').trim().slice(0, 40), address = String(input.customer?.address || '').trim().slice(0, 500);
        if (!name || !phone || !address) return send(res, 400, { error: 'Заполните имя, телефон и адрес доставки.' });
        const orders = await readList('orders.json');
        const customerId = currentAccount(req);
        const order = { id: 'H-' + Date.now().toString(36).toUpperCase(), createdAt: new Date().toISOString(), status: 'new', customer: { name, phone, address }, ...(customerId ? { customerId } : {}), items: lines, total: lines.reduce((sum, x) => sum + x.qty * x.price, 0) };
        for (const line of lines) products.find(p => p.id === line.id).stock -= line.qty;
        orders.unshift(order);
        await writeList('products.json', products);
        await writeList('orders.json', orders);
        return send(res, 201, { id: order.id, message: 'Заказ принят. Магазин свяжется с вами для подтверждения.' });
      });
    }
    if (url.pathname === '/api/admin/login' && req.method === 'POST') {
      const input = await body(req);
      if (input.username !== USER || input.password !== PASS) return send(res, 401, { error: 'Неверный логин или пароль.' });
      const id = crypto.randomBytes(32).toString('hex'); sessions.set(id, Date.now() + 8 * 60 * 60 * 1000);
      return send(res, 200, { ok: true }, { 'Set-Cookie': 'hipos_session=' + id + '; HttpOnly; SameSite=Strict; Path=/; Max-Age=28800' + cookieSecure });
    }
    if (url.pathname === '/api/admin/logout' && req.method === 'POST') {
      sessions.delete(cookie(req, 'hipos_session'));
      return send(res, 200, { ok: true }, { 'Set-Cookie': 'hipos_session=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0' + cookieSecure });
    }
    if (url.pathname === '/api/admin/session' && req.method === 'GET') return send(res, authenticated(req) ? 200 : 401, { authenticated: authenticated(req) });
    if (url.pathname.startsWith('/api/admin/')) {
      if (!authenticated(req)) return send(res, 401, { error: 'Войдите в админ-панель.' });
      if (url.pathname === '/api/admin/orders' && req.method === 'GET') return send(res, 200, await readList('orders.json'));
      if (url.pathname.startsWith('/api/admin/orders/') && req.method === 'PATCH') {
        const id = decodeURIComponent(url.pathname.split('/').pop()), input = await body(req);
        return await withInventoryLock(async () => {
          const orders = await readList('orders.json'), order = orders.find(x => x.id === id);
          if (!order) return send(res, 404, { error: 'Заказ не найден.' });
          if (!['new', 'supplier', 'shipped', 'done', 'cancelled'].includes(input.status)) return send(res, 400, { error: 'Неизвестный статус.' });
          if (order.status !== 'cancelled' && input.status === 'cancelled') {
            const products = await readList('products.json');
            for (const line of order.items) {
              const product = products.find(p => p.id === line.id);
              if (product) product.stock += line.qty;
            }
            await writeList('products.json', products);
          } else if (order.status === 'cancelled' && input.status !== 'cancelled') {
            const products = await readList('products.json');
            for (const line of order.items) {
              const product = products.find(p => p.id === line.id);
              if (!product || product.stock < line.qty) return send(res, 400, { error: 'Недостаточно остатка, чтобы возобновить этот заказ.' });
            }
            for (const line of order.items) products.find(p => p.id === line.id).stock -= line.qty;
            await writeList('products.json', products);
          }
          order.status = input.status; await writeList('orders.json', orders); return send(res, 200, order);
        });
      }
      if (url.pathname === '/api/admin/products' && req.method === 'GET') return send(res, 200, await readList('products.json'));
      if (url.pathname === '/api/admin/products' && req.method === 'POST') {
        const list = await readList('products.json'), product = cleanProduct(await body(req));
        if (list.some(x => x.id === product.id)) return send(res, 409, { error: 'Такой ID уже используется.' });
        list.unshift(product); await writeList('products.json', list); return send(res, 201, product);
      }
      if (url.pathname.startsWith('/api/admin/products/') && req.method === 'PUT') {
        const id = decodeURIComponent(url.pathname.split('/').pop()), list = await readList('products.json'), i = list.findIndex(x => x.id === id);
        if (i < 0) return send(res, 404, { error: 'Товар не найден.' });
        list[i] = cleanProduct(await body(req), list[i]); await writeList('products.json', list); return send(res, 200, list[i]);
      }
      if (url.pathname.startsWith('/api/admin/products/') && req.method === 'DELETE') {
        const id = decodeURIComponent(url.pathname.split('/').pop()), list = await readList('products.json'), next = list.filter(x => x.id !== id);
        if (next.length === list.length) return send(res, 404, { error: 'Товар не найден.' });
        await writeList('products.json', next); return send(res, 200, { ok: true });
      }
      return send(res, 404, { error: 'Маршрут не найден.' });
    }
    const filename = FILES[url.pathname];
    if (req.method === 'GET' && filename) {
      const file = await fs.readFile(path.join(ROOT, filename));
      res.writeHead(200, { 'Content-Type': contentTypes[path.extname(filename)], 'X-Content-Type-Options': 'nosniff', 'Cache-Control': 'no-cache' });
      return res.end(file);
    }
    return send(res, 404, 'Страница не найдена.');
  } catch (error) {
    console.error(error);
    return send(res, error.status || 500, { error: error.status ? error.message : 'Внутренняя ошибка сервера.' });
  }
}
fs.mkdir(DATA, { recursive: true }).then(() => {
  const server = http.createServer((req, res) => { handle(req, res); });
  server.listen(Number(process.env.PORT || 3000), HOST, () => console.log('Hipos is available at http://' + HOST + ':' + (process.env.PORT || 3000)));
}).catch(error => { console.error(error); process.exit(1); });
