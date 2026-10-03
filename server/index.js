import 'dotenv/config';
import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import bcrypt from 'bcryptjs';
import connectPgSimple from 'connect-pg-simple';
import express from 'express';
import { rateLimit } from 'express-rate-limit';
import session from 'express-session';
import helmet from 'helmet';
import multer from 'multer';
import { z } from 'zod';
import { inTransaction, migrate, pool } from './db.js';
import { createCheckoutPreference, getPayment, verifyWebhookSignature } from './mercado-pago.js';
import { derivePaymentState } from './payment-state.js';
import { bootstrapAdmin, loadSessionUser, normalizeEmail, publicUser, requireAdmin, requireUser } from './security.js';

const app = express();
const rootDir = fileURLToPath(new URL('../', import.meta.url));
const distDir = path.join(rootDir, 'dist');
const uploadsDir = path.join(rootDir, 'uploads');
const port = Number(process.env.PORT || 3000);
const sessionSecret = process.env.SESSION_SECRET || '';
const sessionCookie = process.env.SESSION_COOKIE_NAME || 'aether_sid';
const isProduction = process.env.NODE_ENV === 'production';

if (Buffer.byteLength(sessionSecret, 'utf8') < (isProduction ? 64 : 32)) {
  throw new Error(`SESSION_SECRET precisa ter pelo menos ${isProduction ? 64 : 32} bytes${isProduction ? ' em produção' : ''}.`);
}
if (!/^[A-Za-z0-9_-]{1,64}$/.test(sessionCookie)) {
  throw new Error('SESSION_COOKIE_NAME contém caracteres inválidos.');
}
if (process.env.MP_EXPECT_LIVE !== undefined && !['true', 'false'].includes(process.env.MP_EXPECT_LIVE)) {
  throw new Error('MP_EXPECT_LIVE deve ser exatamente true ou false.');
}
if (isProduction) {
  let publicUrl;
  try {
    publicUrl = new URL(process.env.APP_URL || '');
  } catch {
    throw new Error('APP_URL precisa ser a URL pública HTTPS da loja.');
  }
  if (publicUrl.protocol !== 'https:' || publicUrl.port || publicUrl.username || publicUrl.password
    || publicUrl.pathname !== '/' || publicUrl.search || publicUrl.hash) {
    throw new Error('APP_URL em produção deve ser uma origem HTTPS pública sem porta, por exemplo https://loja.example.');
  }
  if (!process.env.ADMIN_EMAIL || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(process.env.ADMIN_EMAIL.trim())) {
    throw new Error('Configure um ADMIN_EMAIL válido antes de iniciar em produção.');
  }
}

app.disable('x-powered-by');
if (isProduction) app.set('trust proxy', 1);
app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      baseUri: ["'self'"],
      objectSrc: ["'none'"],
      frameAncestors: ["'none'"],
      imgSrc: ["'self'", 'data:', 'https:'],
      styleSrc: ["'self'", "'unsafe-inline'", 'https://fonts.googleapis.com'],
      fontSrc: ["'self'", 'data:', 'https://fonts.gstatic.com'],
      scriptSrc: ["'self'"],
      connectSrc: ["'self'", 'https://viacep.com.br'],
      formAction: ["'self'", 'https://www.mercadopago.com.br'],
    },
  },
}));
app.use(express.json({ limit: '64kb' }));
app.use(express.urlencoded({ extended: false, limit: '16kb' }));
await mkdir(uploadsDir, { recursive: true });

const PgSession = connectPgSimple(session);
app.use('/api', session({
  name: sessionCookie,
  secret: sessionSecret,
  store: new PgSession({ pool, tableName: 'aether_sessions', createTableIfMissing: true }),
  resave: false,
  saveUninitialized: false,
  rolling: true,
  cookie: {
    httpOnly: true,
    secure: isProduction,
    sameSite: 'lax',
    maxAge: 7 * 24 * 60 * 60 * 1000,
    path: '/',
  },
}));

app.use('/api', (req, res, next) => {
  if (['GET', 'HEAD', 'OPTIONS'].includes(req.method) || req.path === '/payments/webhook') return next();
  const origin = req.get('origin');
  const host = req.get('x-forwarded-host') || req.get('host');
  if (!origin || !host) return res.status(403).json({ error: 'Origem da solicitação não permitida.' });
  try {
    if (new URL(origin).host !== host) return res.status(403).json({ error: 'Origem da solicitação não permitida.' });
  } catch {
    return res.status(403).json({ error: 'Origem da solicitação não permitida.' });
  }
  next();
});

app.use('/api', rateLimit({ windowMs: 15 * 60 * 1000, limit: 180, standardHeaders: true, legacyHeaders: false }));
app.use('/api', (_req, res, next) => {
  res.set('Cache-Control', 'no-store');
  next();
});
app.use('/api', loadSessionUser);

const authLimiter = rateLimit({ windowMs: 15 * 60 * 1000, limit: 12, standardHeaders: true, legacyHeaders: false });
const checkoutLimiter = rateLimit({ windowMs: 15 * 60 * 1000, limit: 8, standardHeaders: true, legacyHeaders: false });
const dummyPasswordHash = await bcrypt.hash(randomUUID(), 12);
const emailSchema = z.string().trim().email().max(254).transform(normalizeEmail);
const passwordSchema = z.string().min(10).max(72).refine((password) => Buffer.byteLength(password, 'utf8') <= 72, {
  message: 'A senha pode ter no máximo 72 bytes em UTF-8.',
});
const registerSchema = z.object({
  name: z.string().trim().min(2).max(100),
  email: emailSchema,
  password: passwordSchema,
});
const loginSchema = z.object({ email: emailSchema, password: passwordSchema });
const productSchema = z.object({
  name: z.string().trim().min(2).max(140),
  category: z.enum(['Anime', 'Games', 'Quadrinhos', 'Filmes', 'Outros']),
  description: z.string().trim().max(2000).default(''),
  priceCents: z.number().int().min(1).max(100_000_000),
  compareAtCents: z.number().int().min(1).max(100_000_000).nullable().default(null),
  stock: z.number().int().min(0).max(100_000),
  imageUrl: z.string().trim().max(2048).nullable().default(null),
  active: z.boolean().default(true),
}).refine((item) => item.compareAtCents === null || item.compareAtCents >= item.priceCents, {
  message: 'O preço promocional deve ser menor que o preço original.',
  path: ['compareAtCents'],
});
const featuredProductsSchema = z.object({
  productIds: z.array(z.string().uuid()).max(4).refine((ids) => new Set(ids).size === ids.length, 'Não repita figures nos destaques.'),
});
const shippingSchema = z.object({
  street: z.string().trim().min(2).max(160),
  number: z.string().trim().min(1).max(20),
  district: z.string().trim().max(100).default(''),
  city: z.string().trim().min(2).max(100),
  state: z.string().trim().length(2).transform((value) => value.toUpperCase()),
  postalCode: z.string().transform((value) => value.replace(/\D/g, '')).refine((value) => value.length === 8, 'Informe um CEP válido.'),
});
const checkoutSchema = z.object({
  items: z.array(z.object({ productId: z.string().uuid(), quantity: z.number().int().min(1).max(10) })).min(1).max(20),
  shippingAddress: shippingSchema,
  paymentMethod: z.enum(['pix', 'other']).default('other'),
});
const imageUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 5 * 1024 * 1024, files: 1 },
  fileFilter(_req, file, callback) {
    if (!['image/jpeg', 'image/png', 'image/webp'].includes(file.mimetype)) {
      const error = new Error('Envie uma imagem JPG, PNG ou WebP.');
      error.status = 400;
      return callback(error);
    }
    callback(null, true);
  },
});

function parse(schema, body) {
  const result = schema.safeParse(body);
  if (!result.success) {
    const error = new Error(result.error.issues[0]?.message || 'Confira os dados enviados.');
    error.status = 400;
    throw error;
  }
  return result.data;
}

function productDto(row) {
  return {
    id: row.id,
    name: row.name,
    category: row.category,
    description: row.description,
    priceCents: Number(row.price_cents),
    compareAtCents: row.compare_at_cents === null ? null : Number(row.compare_at_cents),
    stock: Number(row.stock),
    imageUrl: row.image_url,
    active: row.active,
    featuredPosition: row.featured_position === null ? null : Number(row.featured_position),
    createdAt: row.created_at,
  };
}

function orderDto(order, items) {
  return {
    id: order.id,
    status: order.status,
    paymentStatus: order.payment_status || 'pending',
    refundedCents: Number(order.refunded_cents || 0),
    totalCents: Number(order.total_cents),
    shippingAddress: order.shipping_address,
    createdAt: order.created_at,
    items: items.map((item) => ({
      productName: item.product_name,
      quantity: Number(item.quantity),
      unitPriceCents: Number(item.unit_price_cents),
    })),
  };
}

app.get('/api/health', async (_req, res) => {
  await pool.query('SELECT 1');
  res.json({ status: 'ok' });
});

app.get('/api/config', (_req, res) => {
  res.json({ paymentsEnabled: Boolean(process.env.MP_ACCESS_TOKEN && process.env.MP_WEBHOOK_SECRET && process.env.APP_URL) });
});

app.post('/api/newsletter', async (req, res) => {
  const { email } = parse(z.object({ email: emailSchema }), req.body);
  await pool.query(
    'INSERT INTO newsletter_subscribers (id, email) VALUES ($1, $2) ON CONFLICT (email) DO NOTHING',
    [randomUUID(), email],
  );
  res.status(201).json({ ok: true });
});

app.get('/api/products', async (_req, res) => {
  const { rows } = await pool.query('SELECT * FROM products WHERE active = TRUE ORDER BY created_at DESC, name ASC');
  res.json(rows.map(productDto));
});

app.post('/api/admin/uploads', requireUser, requireAdmin, imageUpload.single('image'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'Selecione uma imagem JPG, PNG ou WebP.' });
  const header = req.file.buffer.subarray(0, 12).toString('hex');
  const formats = [
    { mime: 'image/jpeg', extension: 'jpg', signature: (hex) => hex.startsWith('ffd8ff') },
    { mime: 'image/png', extension: 'png', signature: (hex) => hex.startsWith('89504e470d0a1a0a') },
    { mime: 'image/webp', extension: 'webp', signature: (hex) => hex.startsWith('52494646') && hex.includes('57454250') },
  ];
  const type = formats.find((format) => format.mime === req.file.mimetype && format.signature(header));
  if (!type) return res.status(400).json({ error: 'O conteúdo do arquivo não corresponde a uma imagem permitida.' });
  const filename = `${randomUUID()}.${type.extension}`;
  await writeFile(path.join(uploadsDir, filename), req.file.buffer, { flag: 'wx', mode: 0o640 });
  res.status(201).json({ imageUrl: `/uploads/${filename}` });
});

app.get('/api/auth/me', (req, res) => {
  res.json({ user: req.user ? publicUser(req.user) : null });
});

app.post('/api/auth/register', authLimiter, async (req, res) => {
  const data = parse(registerSchema, req.body);
  const adminEmail = process.env.ADMIN_EMAIL ? normalizeEmail(process.env.ADMIN_EMAIL) : '';
  if (data.email === adminEmail) {
    return res.status(409).json({ error: 'A conta administradora deve ser criada na configuração do servidor.' });
  }

  const passwordHash = await bcrypt.hash(data.password, 12);
  const id = randomUUID();
  try {
    await pool.query('INSERT INTO users (id, email, name, password_hash) VALUES ($1, $2, $3, $4)', [id, data.email, data.name, passwordHash]);
  } catch (error) {
    if (error.code === '23505') return res.status(409).json({ error: 'Este e-mail já possui uma conta.' });
    throw error;
  }

  await new Promise((resolve, reject) => req.session.regenerate((error) => error ? reject(error) : resolve()));
  req.session.userId = id;
  const { rows } = await pool.query('SELECT id, email, name, is_admin, created_at FROM users WHERE id = $1', [id]);
  res.status(201).json({ user: publicUser(rows[0]) });
});

app.post('/api/auth/login', authLimiter, async (req, res) => {
  const data = parse(loginSchema, req.body);
  const { rows } = await pool.query('SELECT * FROM users WHERE email = $1', [data.email]);
  const user = rows[0];
  const passwordMatches = await bcrypt.compare(data.password, user?.password_hash || dummyPasswordHash);
  if (!user || !passwordMatches) {
    return res.status(401).json({ error: 'E-mail ou senha incorretos.' });
  }

  await new Promise((resolve, reject) => req.session.regenerate((error) => error ? reject(error) : resolve()));
  req.session.userId = user.id;
  res.json({ user: publicUser(user) });
});

app.post('/api/auth/logout', requireUser, (req, res, next) => {
  req.session.destroy((error) => {
    if (error) return next(error);
    res.clearCookie(sessionCookie, { httpOnly: true, sameSite: 'lax', secure: isProduction, path: '/' });
    res.sendStatus(204);
  });
});

app.put('/api/auth/password', authLimiter, requireUser, async (req, res) => {
  const data = parse(z.object({
    currentPassword: passwordSchema,
    newPassword: passwordSchema,
  }), req.body);
  const { rows } = await pool.query('SELECT password_hash FROM users WHERE id=$1', [req.user.id]);
  if (!rows[0] || !(await bcrypt.compare(data.currentPassword, rows[0].password_hash))) {
    return res.status(400).json({ error: 'A senha atual está incorreta.' });
  }
  const passwordHash = await bcrypt.hash(data.newPassword, 12);
  await pool.query('UPDATE users SET password_hash=$2 WHERE id=$1', [req.user.id, passwordHash]);
  await pool.query('DELETE FROM aether_sessions WHERE sess->>\'userId\'=$1 AND sid<>$2', [req.user.id, req.sessionID]);
  await new Promise((resolve, reject) => req.session.regenerate((error) => error ? reject(error) : resolve()));
  req.session.userId = req.user.id;
  res.sendStatus(204);
});

app.get('/api/orders', requireUser, async (req, res) => {
  const { rows: orders } = await pool.query('SELECT * FROM orders WHERE user_id = $1 ORDER BY created_at DESC', [req.user.id]);
  const orderIds = orders.map((order) => order.id);
  const { rows: items } = orderIds.length
    ? await pool.query('SELECT * FROM order_items WHERE order_id = ANY($1::uuid[]) ORDER BY product_name', [orderIds])
    : { rows: [] };
  const byOrder = Map.groupBy ? Map.groupBy(items, (item) => item.order_id) : items.reduce((map, item) => {
    const group = map.get(item.order_id) || [];
    group.push(item);
    map.set(item.order_id, group);
    return map;
  }, new Map());
  res.json(orders.map((order) => orderDto(order, byOrder.get(order.id) || [])));
});

async function releaseReservation(orderId, status) {
  return inTransaction(async (client) => {
    const { rows } = await client.query('SELECT status FROM orders WHERE id = $1 FOR UPDATE', [orderId]);
    if (!rows[0] || rows[0].status !== 'pending_payment') return false;
    await client.query(
      `UPDATE products p SET stock = p.stock + item_totals.quantity, updated_at = NOW()
       FROM (SELECT product_id, SUM(quantity)::INTEGER AS quantity FROM order_items WHERE order_id = $1 AND product_id IS NOT NULL GROUP BY product_id) item_totals
       WHERE p.id = item_totals.product_id`,
      [orderId],
    );
    await client.query('UPDATE orders SET status = $2, updated_at = NOW() WHERE id = $1', [orderId, status]);
    return true;
  });
}

async function expireReservations() {
  const { rows } = await pool.query(
    `SELECT id FROM orders WHERE status = 'pending_payment' AND reservation_expires_at < NOW() LIMIT 50`,
  );
  for (const order of rows) await releaseReservation(order.id, 'expired');
}

app.post('/api/orders', requireUser, checkoutLimiter, async (req, res) => {
  if (!process.env.MP_ACCESS_TOKEN || !process.env.MP_WEBHOOK_SECRET || !process.env.APP_URL) {
    return res.status(503).json({ error: 'A finalização online está temporariamente indisponível. Tente novamente mais tarde.' });
  }
  const data = parse(checkoutSchema, req.body);
  const quantities = new Map();
  for (const item of data.items) quantities.set(item.productId, (quantities.get(item.productId) || 0) + item.quantity);
  const lines = [...quantities].map(([productId, quantity]) => ({ productId, quantity }));
  if (lines.some((item) => item.quantity > 10)) return res.status(400).json({ error: 'Limite de 10 unidades por figure.' });

  const orderId = randomUUID();
  let created;
  try {
    created = await inTransaction(async (client) => {
      const ids = lines.map((item) => item.productId);
      const { rows: products } = await client.query(
        'SELECT * FROM products WHERE id = ANY($1::uuid[]) AND active = TRUE ORDER BY id FOR UPDATE',
        [ids],
      );
      if (products.length !== ids.length) {
        const error = new Error('Uma das figures não está mais disponível. Atualize o catálogo.');
        error.status = 409;
        throw error;
      }

      let totalCents = 0;
      const orderItems = [];
      for (const line of lines) {
        const product = products.find((candidate) => candidate.id === line.productId);
        if (!product || product.stock < line.quantity) {
          const error = new Error(`Estoque insuficiente para ${product?.name || 'uma figure'}.`);
          error.status = 409;
          throw error;
        }
        const lineTotal = Number(product.price_cents) * line.quantity;
        if (!Number.isSafeInteger(lineTotal) || !Number.isSafeInteger(totalCents + lineTotal)) {
          const error = new Error('O total do pedido excede o limite permitido.');
          error.status = 400;
          throw error;
        }
        totalCents += lineTotal;
        orderItems.push({ product, quantity: line.quantity });
        await client.query('UPDATE products SET stock = stock - $2, updated_at = NOW() WHERE id = $1', [product.id, line.quantity]);
      }

      const { rows: [insertedOrder] } = await client.query(
        `INSERT INTO orders (id, user_id, total_cents, shipping_address)
         VALUES ($1, $2, $3, $4) RETURNING reservation_expires_at`,
        [orderId, req.user.id, totalCents, JSON.stringify(data.shippingAddress)],
      );
      for (const { product, quantity } of orderItems) {
        await client.query(
          `INSERT INTO order_items (id, order_id, product_id, product_name, quantity, unit_price_cents)
           VALUES ($1, $2, $3, $4, $5, $6)`,
          [randomUUID(), orderId, product.id, product.name, quantity, product.price_cents],
        );
      }
      return { order: { id: orderId, total_cents: totalCents, reservation_expires_at: insertedOrder.reservation_expires_at }, items: orderItems.map(({ product, quantity }) => ({
        product_id: product.id,
        product_name: product.name,
        quantity,
        unit_price_cents: Number(product.price_cents),
      })) };
    });
  } catch (error) {
    throw error;
  }

  try {
    const preference = await createCheckoutPreference({
      order: created.order,
      items: created.items,
      buyer: req.user,
      shippingAddress: data.shippingAddress,
      paymentMethod: data.paymentMethod,
    });
    await pool.query('UPDATE orders SET payment_preference_id = $2, updated_at = NOW() WHERE id = $1', [orderId, preference.id]);
    return res.status(201).json({ orderId, checkoutUrl: preference.url });
  } catch (error) {
    // A timeout or network error can happen after Mercado Pago accepted the
    // preference. Keep the stock reserved until expiry to avoid overselling.
    console.error(`[aether] Checkout preference could not be confirmed for order ${orderId}.`);
    throw error;
  }
});

app.post('/api/payments/webhook', async (req, res) => {
  const dataId = String(req.query['data.id'] || '');
  if (!/^\d{1,30}$/.test(dataId)) return res.sendStatus(401);
  const isValid = verifyWebhookSignature({
    signature: req.get('x-signature'),
    requestId: req.get('x-request-id'),
    dataId,
    secret: process.env.MP_WEBHOOK_SECRET,
  });
  if (!isValid) return res.sendStatus(401);

  try {
    const payment = await getPayment(dataId);
    const orderId = payment.external_reference;
    const expectedLiveMode = process.env.MP_EXPECT_LIVE === undefined
      ? isProduction
      : process.env.MP_EXPECT_LIVE === 'true';
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(orderId || '')
      || String(payment.id) !== dataId
      || payment.live_mode !== expectedLiveMode
      || !Number.isFinite(Number(payment.transaction_amount))
      || payment.currency_id !== 'BRL') return res.sendStatus(200);

    await inTransaction(async (client) => {
      const { rows } = await client.query('SELECT * FROM orders WHERE id = $1 FOR UPDATE', [orderId]);
      const order = rows[0];
      if (!order || Number(order.total_cents) !== Math.round(Number(payment.transaction_amount) * 100)) return;

      const paymentState = derivePaymentState(payment, Number(order.total_cents));
      if (!paymentState) throw new Error('Mercado Pago returned an invalid refunded amount.');

      const paymentId = String(payment.id);
      if (order.payment_id && order.payment_id !== paymentId) {
        console.error(`[aether] Multiple approved payments reference order ${orderId}; review payment ${paymentId}.`);
        return;
      }

      let nextOrderStatus = order.status;
      if (['approved', 'partially_refunded'].includes(paymentState.paymentStatus)) {
        if (order.status === 'pending_payment') nextOrderStatus = 'paid';
        else if (order.status === 'expired' || order.status === 'checkout_error') nextOrderStatus = 'paid_after_expiry';
      }

      const bindsPaymentId = ['approved', 'partially_refunded', 'refunded', 'in_mediation', 'charged_back']
        .includes(paymentState.paymentStatus);
      await client.query(
        `UPDATE orders
         SET status = $2,
             payment_status = $3,
             payment_id = CASE WHEN $4 THEN $5 ELSE payment_id END,
             refunded_cents = GREATEST(refunded_cents, $6),
             updated_at = NOW()
         WHERE id = $1`,
        [orderId, nextOrderStatus, paymentState.paymentStatus, bindsPaymentId, paymentId, paymentState.refundedCents],
      );
    });
    res.sendStatus(200);
  } catch (error) {
    console.error('[aether] Webhook processing failed:', error.message);
    res.sendStatus(500);
  }
});

app.get('/api/admin/products', requireUser, requireAdmin, async (_req, res) => {
  const { rows } = await pool.query('SELECT * FROM products ORDER BY created_at DESC, name ASC');
  res.json(rows.map(productDto));
});

app.put('/api/admin/featured', requireUser, requireAdmin, async (req, res) => {
  const { productIds } = parse(featuredProductsSchema, req.body);
  await inTransaction(async (client) => {
    await client.query('SELECT pg_advisory_xact_lock(731904251)');
    const { rows } = await client.query(
      'SELECT id, active, image_url FROM products WHERE id = ANY($1::uuid[]) FOR UPDATE',
      [productIds],
    );
    if (rows.length !== productIds.length) {
      const error = new Error('Uma das figures selecionadas não foi encontrada. Atualize o catálogo.');
      error.status = 409;
      throw error;
    }
    if (rows.some((product) => !product.active || !product.image_url)) {
      const error = new Error('Destaque apenas figures publicadas que tenham uma imagem.');
      error.status = 400;
      throw error;
    }

    await client.query('UPDATE products SET featured_position=NULL WHERE featured_position IS NOT NULL');
    for (const [index, productId] of productIds.entries()) {
      await client.query('UPDATE products SET featured_position=$2, updated_at=NOW() WHERE id=$1', [productId, index + 1]);
    }
  });
  res.json({ productIds });
});

app.post('/api/admin/products', requireUser, requireAdmin, async (req, res) => {
  const data = parse(productSchema, req.body);
  if (data.imageUrl && !/^https:\/\//i.test(data.imageUrl) && !/^\/uploads\/[\w-]+\.(jpg|png|webp)$/i.test(data.imageUrl)) {
    return res.status(400).json({ error: 'Envie uma imagem ou use um endereço HTTPS.' });
  }
  const id = randomUUID();
  const { rows } = await pool.query(
    `INSERT INTO products (id, name, category, description, price_cents, compare_at_cents, stock, image_url, active)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) RETURNING *`,
    [id, data.name, data.category, data.description, data.priceCents, data.compareAtCents, data.stock, data.imageUrl, data.active],
  );
  res.status(201).json(productDto(rows[0]));
});

app.put('/api/admin/products/:id', requireUser, requireAdmin, async (req, res) => {
  const data = parse(productSchema, req.body);
  if (data.imageUrl && !/^https:\/\//i.test(data.imageUrl) && !/^\/uploads\/[\w-]+\.(jpg|png|webp)$/i.test(data.imageUrl)) {
    return res.status(400).json({ error: 'Envie uma imagem ou use um endereço HTTPS.' });
  }
  const { rows } = await pool.query(
    `UPDATE products SET name=$2, category=$3, description=$4, price_cents=$5,
       compare_at_cents=$6, stock=$7, image_url=$8, active=$9,
       featured_position=CASE WHEN $9=TRUE AND $8 IS NOT NULL THEN featured_position ELSE NULL END,
       updated_at=NOW()
     WHERE id=$1 RETURNING *`,
    [req.params.id, data.name, data.category, data.description, data.priceCents, data.compareAtCents, data.stock, data.imageUrl, data.active],
  );
  if (!rows[0]) return res.status(404).json({ error: 'Figure não encontrada.' });
  res.json(productDto(rows[0]));
});

app.delete('/api/admin/products/:id', requireUser, requireAdmin, async (req, res) => {
  const { rowCount } = await pool.query('UPDATE products SET active=FALSE, featured_position=NULL, updated_at=NOW() WHERE id=$1 AND active=TRUE', [req.params.id]);
  if (!rowCount) return res.status(404).json({ error: 'Figure não encontrada no catálogo.' });
  res.sendStatus(204);
});

app.get('/api/admin/orders', requireUser, requireAdmin, async (_req, res) => {
  const { rows } = await pool.query(
    `SELECT o.*, u.name AS customer_name, u.email AS customer_email
     FROM orders o JOIN users u ON u.id=o.user_id ORDER BY o.created_at DESC LIMIT 200`,
  );
  const orderIds = rows.map((order) => order.id);
  const { rows: items } = orderIds.length
    ? await pool.query('SELECT * FROM order_items WHERE order_id = ANY($1::uuid[])', [orderIds])
    : { rows: [] };
  const grouped = items.reduce((map, item) => {
    const group = map.get(item.order_id) || [];
    group.push({ productName: item.product_name, quantity: Number(item.quantity), unitPriceCents: Number(item.unit_price_cents) });
    map.set(item.order_id, group);
    return map;
  }, new Map());
  res.json(rows.map((order) => ({
    ...orderDto(order, grouped.get(order.id) || []),
    customer: { name: order.customer_name, email: order.customer_email },
  })));
});

app.use('/uploads', express.static(uploadsDir, { maxAge: isProduction ? '30d' : 0, immutable: isProduction }));

if (existsSync(distDir)) {
  app.use(express.static(distDir, { index: false, maxAge: isProduction ? '1d' : 0 }));
  app.get('/{*path}', (req, res, next) => {
    if (req.path.startsWith('/api/')) return next();
    res.sendFile(path.join(distDir, 'index.html'));
  });
}

app.use((error, _req, res, _next) => {
  if (res.headersSent) return;
  if (error instanceof multer.MulterError) {
    const message = error.code === 'LIMIT_FILE_SIZE' ? 'A imagem deve ter no máximo 5 MB.' : 'Não foi possível receber essa imagem.';
    return res.status(400).json({ error: message });
  }
  if (error.status && error.status < 500) return res.status(error.status).json({ error: error.message });
  console.error('[aether] Request failed:', error.message);
  res.status(500).json({ error: 'Não foi possível concluir a solicitação agora.' });
});

async function start() {
  await migrate();
  await bootstrapAdmin();
  const server = app.listen(port, '0.0.0.0', () => console.info(`[aether] API pronta na porta ${port}.`));
  const cleanupTimer = setInterval(() => expireReservations().catch((error) => console.error('[aether] Reservation cleanup failed:', error.message)), 60_000);
  cleanupTimer.unref();
  const shutdown = async () => {
    clearInterval(cleanupTimer);
    server.close(async () => {
      await pool.end();
      process.exit(0);
    });
    setTimeout(() => process.exit(1), 10_000).unref();
  };
  process.once('SIGINT', shutdown);
  process.once('SIGTERM', shutdown);
}

start().catch((error) => {
  console.error('[aether] Startup failed:', error.message);
  process.exit(1);
});
