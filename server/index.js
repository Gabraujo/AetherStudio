import 'dotenv/config';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, unlink, writeFile } from 'node:fs/promises';
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
import { createDirectPayment, getPayment, verifyWebhookSignature } from './mercado-pago.js';
import { derivePaymentState } from './payment-state.js';
import { bootstrapAdmin, loadSessionUser, normalizeEmail, publicUser, requireAdmin, requireUser } from './security.js';
import { emailEnabled, enqueueEmail, sendTransactionalEmail, startEmailWorker } from './email.js';

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
      scriptSrc: ["'self'", 'https://sdk.mercadopago.com', 'https://www.mercadopago.com', 'https://*.mercadopago.com', 'https://*.mercadopago.com.br', 'https://http2.mlstatic.com'],
      connectSrc: ["'self'", 'https://viacep.com.br', 'https://api.mercadopago.com', 'https://api.mercadolibre.com', 'https://www.mercadopago.com', 'https://*.mercadopago.com', 'https://*.mercadopago.com.br', 'https://http2.mlstatic.com'],
      frameSrc: ["'self'", 'https://*.mercadopago.com', 'https://*.mercadopago.com.br'],
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
const passwordResetLimiter = rateLimit({ windowMs: 60 * 60 * 1000, limit: 5, standardHeaders: true, legacyHeaders: false });
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
});
const paymentAttemptSchema = z.object({
  idempotencyKey: z.string().uuid(),
  paymentMethod: z.enum(['pix', 'card']),
  deviceId: z.string().trim().min(1).max(512).optional(),
  formData: z.object({
    token: z.string().trim().min(1).max(512),
    payment_method_id: z.string().trim().regex(/^[a-zA-Z0-9_-]{1,40}$/).refine((value) => value.toLowerCase() !== 'pix'),
    installments: z.number().int().min(1).max(24),
    issuer_id: z.union([z.string().regex(/^\d{1,20}$/), z.number().int().positive()]).optional(),
    payer: z.object({
      identification: z.object({ type: z.enum(['CPF', 'CNPJ']), number: z.string().regex(/^\d{11}$|^\d{14}$/) }),
    }),
  }).optional(),
}).superRefine((data, context) => {
  if (data.paymentMethod === 'card' && !data.formData) context.addIssue({ code: 'custom', path: ['formData'], message: 'Dados do cartão incompletos.' });
  if (data.paymentMethod === 'pix' && data.formData) context.addIssue({ code: 'custom', path: ['formData'], message: 'Dados de cartão não são aceitos para Pix.' });
  if (data.formData && data.formData.payer.identification.type === 'CPF' && data.formData.payer.identification.number.length !== 11) {
    context.addIssue({ code: 'custom', path: ['formData', 'payer', 'identification', 'number'], message: 'CPF inválido.' });
  }
  if (data.formData && data.formData.payer.identification.type === 'CNPJ' && data.formData.payer.identification.number.length !== 14) {
    context.addIssue({ code: 'custom', path: ['formData', 'payer', 'identification', 'number'], message: 'CNPJ inválido.' });
  }
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
  const reservationExpiresAt = order.reservation_expires_at ? new Date(order.reservation_expires_at) : null;
  const reservationActive = reservationExpiresAt && reservationExpiresAt.getTime() > Date.now();
  const paymentIsRetryable = !order.payment_id || ['rejected', 'cancelled'].includes(order.payment_status);
  const isPendingPix = order.payment_id && order.payment_attempt_method === 'pix' && order.payment_status === 'pending';
  return {
    id: order.id,
    status: order.status,
    paymentStatus: order.payment_status || 'pending',
    refundedCents: Number(order.refunded_cents || 0),
    fulfillmentStatus: order.fulfillment_status || 'not_paid',
    trackingCode: order.tracking_code || null,
    totalCents: Number(order.total_cents),
    reservationExpiresAt: reservationExpiresAt?.toISOString() || null,
    canResumePayment: order.status === 'pending_payment' && Boolean(reservationActive) && (paymentIsRetryable || isPendingPix),
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
  const requiredPaymentVariables = ['MP_ACCESS_TOKEN', 'MP_PUBLIC_KEY', 'MP_WEBHOOK_SECRET', 'APP_URL'];
  const missingPaymentVariables = requiredPaymentVariables.filter((name) => !process.env[name]?.trim());
  res.json({
    paymentsEnabled: missingPaymentVariables.length === 0,
    mercadoPagoPublicKey: process.env.MP_PUBLIC_KEY || null,
    emailEnabled: emailEnabled(),
  });
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

app.get('/api/products/:id', async (req, res) => {
  const productId = z.string().uuid().safeParse(req.params.id);
  if (!productId.success) return res.status(404).json({ error: 'Figure não encontrada.' });

  const { rows: products } = await pool.query(
    `SELECT p.*,
            COALESCE(ROUND(AVG(r.rating)::numeric, 1), 0) AS average_rating,
            COUNT(r.id)::integer AS review_count
     FROM products p
     LEFT JOIN product_reviews r ON r.product_id = p.id
     WHERE p.id = $1 AND p.active = TRUE
     GROUP BY p.id`,
    [productId.data],
  );
  const product = products[0];
  if (!product) return res.status(404).json({ error: 'Figure não encontrada.' });

  const [{ rows: reviews }, { rows: ownReviews }, { rows: eligibility }] = await Promise.all([
    pool.query(
      `SELECT r.id, r.rating, r.comment, r.created_at, u.name AS author_name
       FROM product_reviews r
       JOIN users u ON u.id = r.user_id
       WHERE r.product_id = $1
       ORDER BY r.created_at DESC
       LIMIT 100`,
      [product.id],
    ),
    req.user
      ? pool.query('SELECT id, rating, comment FROM product_reviews WHERE product_id=$1 AND user_id=$2', [product.id, req.user.id])
      : Promise.resolve({ rows: [] }),
    req.user
      ? pool.query(
        `SELECT EXISTS (
           SELECT 1 FROM orders o
           JOIN order_items oi ON oi.order_id = o.id
           WHERE o.user_id = $1 AND oi.product_id = $2 AND o.status IN ('paid', 'paid_after_expiry')
         ) AS eligible`,
        [req.user.id, product.id],
      )
      : Promise.resolve({ rows: [{ eligible: false }] }),
  ]);

  res.json({
    product: productDto(product),
    averageRating: Number(product.average_rating),
    reviewCount: Number(product.review_count),
    reviews: reviews.map((review) => ({
      id: review.id,
      rating: Number(review.rating),
      comment: review.comment,
      createdAt: review.created_at,
      authorName: review.author_name,
    })),
    canReview: Boolean(eligibility[0]?.eligible),
    ownReview: ownReviews[0] ? {
      id: ownReviews[0].id,
      rating: Number(ownReviews[0].rating),
      comment: ownReviews[0].comment,
    } : null,
  });
});

app.post('/api/products/:id/reviews', requireUser, async (req, res) => {
  const productId = z.string().uuid().safeParse(req.params.id);
  if (!productId.success) return res.status(404).json({ error: 'Figure não encontrada.' });
  const reviewData = parse(z.object({
    rating: z.number().int().min(1).max(5),
    comment: z.string().trim().min(10, 'Escreva pelo menos 10 caracteres na avaliação.').max(1200),
  }), req.body);

  const { rows: eligible } = await pool.query(
    `SELECT EXISTS (
       SELECT 1 FROM products p
       JOIN order_items oi ON oi.product_id = p.id
       JOIN orders o ON o.id = oi.order_id
       WHERE p.id = $1 AND p.active = TRUE AND o.user_id = $2
         AND o.status IN ('paid', 'paid_after_expiry')
     ) AS allowed`,
    [productId.data, req.user.id],
  );
  if (!eligible[0]?.allowed) {
    return res.status(403).json({ error: 'A avaliação fica disponível após a confirmação de uma compra desta figure.' });
  }

  const { rows } = await pool.query(
    `INSERT INTO product_reviews (id, product_id, user_id, rating, comment)
     VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT (product_id, user_id)
     DO UPDATE SET rating=EXCLUDED.rating, comment=EXCLUDED.comment, updated_at=NOW()
     RETURNING id, rating, comment, created_at`,
    [randomUUID(), productId.data, req.user.id, reviewData.rating, reviewData.comment],
  );
  res.json({ ...rows[0], rating: Number(rows[0].rating), authorName: req.user.name });
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

app.post('/api/auth/password/forgot', passwordResetLimiter, async (req, res) => {
  if (!emailEnabled()) return res.status(503).json({ error: 'A recuperação de senha ainda não está configurada.' });
  const { email } = parse(z.object({ email: emailSchema }), req.body);
  const { rows } = await pool.query('SELECT id, name, email FROM users WHERE email=$1', [email]);
  const user = rows[0];
  if (user) {
    const token = randomBytes(32).toString('base64url');
    const tokenHash = createHash('sha256').update(token).digest('hex');
    await inTransaction(async (client) => {
      await client.query('DELETE FROM password_reset_tokens WHERE user_id=$1', [user.id]);
      await client.query(
        "INSERT INTO password_reset_tokens (token_hash, user_id, expires_at) VALUES ($1, $2, NOW() + INTERVAL '30 minutes')",
        [tokenHash, user.id],
      );
    });
    try {
      await sendTransactionalEmail({
        recipient: user.email,
        template: 'password-reset',
        payload: { name: user.name, url: `${new URL(process.env.APP_URL).origin}/#reset_token=${encodeURIComponent(token)}` },
        idempotencyKey: `password-reset-${randomUUID()}`,
      });
    } catch (error) {
      await pool.query('DELETE FROM password_reset_tokens WHERE token_hash=$1', [tokenHash]);
      console.error('[aether] Password reset email delivery failed:', error.message);
    }
  }
  res.status(202).json({ message: 'Se a conta existir, enviaremos um link para redefinir a senha.' });
});

app.post('/api/auth/password/reset', passwordResetLimiter, async (req, res) => {
  const data = parse(z.object({ token: z.string().min(32).max(128), password: passwordSchema }), req.body);
  const tokenHash = createHash('sha256').update(data.token).digest('hex');
  const passwordHash = await bcrypt.hash(data.password, 12);
  await inTransaction(async (client) => {
    const { rows } = await client.query(
      'SELECT user_id FROM password_reset_tokens WHERE token_hash=$1 AND expires_at>NOW() FOR UPDATE',
      [tokenHash],
    );
    if (!rows[0]) {
      const error = new Error('Este link expirou ou já foi utilizado. Solicite outro link de recuperação.');
      error.status = 400;
      throw error;
    }
    const userId = rows[0].user_id;
    await client.query('UPDATE users SET password_hash=$2 WHERE id=$1', [userId, passwordHash]);
    await client.query('DELETE FROM password_reset_tokens WHERE user_id=$1', [userId]);
    await client.query("DELETE FROM aether_sessions WHERE sess->>'userId'=$1", [userId]);
  });
  res.json({ message: 'Senha atualizada. Entre com sua nova senha.' });
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
  await pool.query('DELETE FROM password_reset_tokens WHERE expires_at < NOW()');
  await pool.query(
    `DELETE FROM email_outbox
     WHERE (status='sent' AND sent_at < NOW() - INTERVAL '30 days')
        OR (status='dead' AND created_at < NOW() - INTERVAL '30 days')`,
  );
}

const paymentStatusLabels = {
  approved: 'Pagamento aprovado', authorized: 'Pagamento autorizado', in_process: 'Pagamento em análise',
  in_mediation: 'Pagamento em contestação', rejected: 'Pagamento recusado', cancelled: 'Pagamento cancelado',
  refunded: 'Pagamento reembolsado', partially_refunded: 'Pagamento parcialmente reembolsado',
  charged_back: 'Pagamento contestado (chargeback)', unknown: 'Status de pagamento desconhecido',
};

async function applyMercadoPagoPayment(client, order, payment) {
  if (!order || Number(order.total_cents) !== Math.round(Number(payment.transaction_amount) * 100)) return false;
  const paymentState = derivePaymentState(payment, Number(order.total_cents));
  if (!paymentState) throw new Error('Mercado Pago returned an invalid refunded amount.');
  const paymentId = String(payment.id);
  if (order.payment_id && order.payment_id !== paymentId && !['rejected', 'cancelled'].includes(order.payment_status)) {
    console.error(`[aether] Multiple payments reference order ${order.id}; review payment ${paymentId}.`);
    return false;
  }
  let nextOrderStatus = order.status;
  if (['approved', 'partially_refunded'].includes(paymentState.paymentStatus)) {
    if (order.status === 'pending_payment') nextOrderStatus = 'paid';
    else if (order.status === 'expired' || order.status === 'checkout_error') nextOrderStatus = 'paid_after_expiry';
  }
  await client.query(
    `UPDATE orders SET status=$2,payment_status=$3,
       fulfillment_status=CASE WHEN $3='approved' AND fulfillment_status='not_paid' THEN 'processing' ELSE fulfillment_status END,
       payment_id=$4,
       payment_attempt_key=CASE WHEN $3 IN ('rejected','cancelled') THEN NULL ELSE payment_attempt_key END,
       payment_attempt_method=CASE WHEN $3 IN ('rejected','cancelled') THEN NULL ELSE payment_attempt_method END,
       refunded_cents=GREATEST(refunded_cents,$5),updated_at=NOW() WHERE id=$1`,
    [order.id, nextOrderStatus, paymentState.paymentStatus, paymentId, paymentState.refundedCents],
  );
  if (order.payment_status !== paymentState.paymentStatus || order.status !== nextOrderStatus) {
    const { rows: [customer] } = await client.query('SELECT email,name FROM users WHERE id=$1', [order.user_id]);
    if (customer) await enqueueEmail(client, {
      eventKey: `payment-update:${paymentId}:${paymentState.paymentStatus}:${paymentState.refundedCents}`,
      recipient: customer.email, template: 'payment-update',
      payload: { name: customer.name, orderId: order.id, totalCents: order.total_cents, paymentStatus: paymentState.paymentStatus,
        refundedCents: paymentState.refundedCents, statusLabel: paymentStatusLabels[paymentState.paymentStatus] || paymentStatusLabels.unknown },
    });
  }
  return true;
}

function directPaymentDto(payment) {
  const data = payment.point_of_interaction?.transaction_data;
  return { paymentId: String(payment.id), status: payment.status, statusDetail: payment.status_detail || null,
    paymentMethod: payment.payment_method_id || null,
    qrCode: data?.qr_code || null, qrCodeBase64: data?.qr_code_base64 || null,
    ticketUrl: data?.ticket_url || null, expirationDate: payment.date_of_expiration || null };
}

app.post('/api/orders', requireUser, checkoutLimiter, async (req, res) => {
  if (!process.env.MP_ACCESS_TOKEN || !process.env.MP_WEBHOOK_SECRET || !process.env.MP_PUBLIC_KEY || !process.env.APP_URL) {
    return res.status(503).json({ error: 'A finalização online está temporariamente indisponível. Tente novamente mais tarde.' });
  }
  const data = parse(checkoutSchema, req.body);
  const quantities = new Map();
  for (const item of data.items) quantities.set(item.productId, (quantities.get(item.productId) || 0) + item.quantity);
  const lines = [...quantities].map(([productId, quantity]) => ({ productId, quantity }));
  if (lines.some((item) => item.quantity > 10)) return res.status(400).json({ error: 'Limite de 10 unidades por figure.' });

  const orderId = randomUUID();
  try {
    const created = await inTransaction(async (client) => {
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
      await enqueueEmail(client, {
        eventKey: `order-created:${orderId}`, recipient: req.user.email, template: 'order-created',
        payload: { name: req.user.name, orderId, totalCents, accountUrl: `${process.env.APP_URL}/#conta` },
      });
      return { order: { id: orderId, total_cents: totalCents, reservation_expires_at: insertedOrder.reservation_expires_at }, items: orderItems.map(({ product, quantity }) => ({
        product_id: product.id,
        product_name: product.name,
        quantity,
        unit_price_cents: Number(product.price_cents),
      })) };
    });
    return res.status(201).json({ orderId: created.order.id, totalCents: created.order.total_cents, expiresAt: created.order.reservation_expires_at });
  } catch (error) {
    throw error;
  }

});

app.post('/api/orders/:id/payment', requireUser, checkoutLimiter, async (req, res) => {
  if (!process.env.MP_ACCESS_TOKEN || !process.env.MP_WEBHOOK_SECRET || !process.env.MP_PUBLIC_KEY || !process.env.APP_URL) {
    return res.status(503).json({ error: 'O pagamento está temporariamente indisponível.' });
  }
  if (!/^[0-9a-f-]{36}$/i.test(req.params.id)) return res.sendStatus(404);
  const attempt = parse(paymentAttemptSchema, req.body);
  const order = await inTransaction(async (client) => {
    const { rows: [row] } = await client.query('SELECT * FROM orders WHERE id=$1 AND user_id=$2 FOR UPDATE', [req.params.id, req.user.id]);
    if (!row) return null;
    if (row.status !== 'pending_payment' || new Date(row.reservation_expires_at).getTime() <= Date.now()) {
      const error = new Error('Este pedido não está mais disponível para pagamento.'); error.status = 409; throw error;
    }
    const retry = row.payment_attempt_key === attempt.idempotencyKey;
    if (row.payment_attempt_key && !retry) { const error = new Error('Já existe uma tentativa de pagamento em andamento.'); error.status = 409; throw error; }
    if (row.payment_id && !['rejected', 'cancelled'].includes(row.payment_status) && !retry) {
      const error = new Error('Este pedido já possui um pagamento em processamento.'); error.status = 409; throw error;
    }
    if (retry && row.payment_attempt_method !== attempt.paymentMethod) {
      const error = new Error('Use o mesmo meio de pagamento para retomar esta tentativa.'); error.status = 409; throw error;
    }
    if (!retry) await client.query('UPDATE orders SET payment_attempt_key=$2,payment_attempt_method=$3,updated_at=NOW() WHERE id=$1', [row.id, attempt.idempotencyKey, attempt.paymentMethod]);
    return row;
  });
  if (!order) return res.sendStatus(404);
  const paymentPayload = attempt.paymentMethod === 'pix'
    ? { paymentMethod: 'pix', expirationAt: new Date(order.reservation_expires_at).toISOString(), deviceId: attempt.deviceId }
    : { paymentMethod: 'card', token: attempt.formData.token, paymentMethodId: attempt.formData.payment_method_id,
      installments: attempt.formData.installments, issuerId: attempt.formData.issuer_id,
      identification: attempt.formData.payer.identification, deviceId: attempt.deviceId };
  let payment;
  try {
    if (order.payment_id && order.payment_attempt_key === attempt.idempotencyKey) payment = await getPayment(order.payment_id);
    else {
      const result = await createDirectPayment({ orderId: order.id, totalCents: Number(order.total_cents), buyer: req.user,
        payment: paymentPayload, notificationUrl: `${new URL(process.env.APP_URL).origin}/api/payments/webhook`, idempotencyKey: attempt.idempotencyKey });
      payment = await getPayment(result.id);
    }
  } catch (error) {
    if (error.status === 422) await pool.query('UPDATE orders SET payment_attempt_key=NULL,payment_attempt_method=NULL WHERE id=$1 AND payment_attempt_key=$2', [order.id, attempt.idempotencyKey]);
    throw error;
  }
  const expectedLiveMode = process.env.MP_EXPECT_LIVE === undefined ? isProduction : process.env.MP_EXPECT_LIVE === 'true';
  if (payment.external_reference !== order.id || payment.currency_id !== 'BRL'
    || Math.round(Number(payment.transaction_amount) * 100) !== Number(order.total_cents) || payment.live_mode !== expectedLiveMode) {
    console.error(`[aether] Mercado Pago payment did not match order ${order.id}.`);
    return res.status(502).json({ error: 'Não foi possível validar o pagamento agora.' });
  }
  await inTransaction(async (client) => {
    const { rows: [current] } = await client.query('SELECT * FROM orders WHERE id=$1 FOR UPDATE', [order.id]);
    await applyMercadoPagoPayment(client, current, payment);
  });
  const result = directPaymentDto(payment);
  if (['rejected', 'cancelled'].includes(payment.status)) return res.status(422).json({ ...result, error: 'Pagamento recusado. Confira os dados ou tente outro meio de pagamento.' });
  res.status(201).json(result);
});

app.get('/api/orders/:id/payment', requireUser, async (req, res) => {
  if (!/^[0-9a-f-]{36}$/i.test(req.params.id)) return res.sendStatus(404);
  const { rows: [order] } = await pool.query(
    'SELECT id,status,payment_status,payment_id,payment_attempt_key,payment_attempt_method,reservation_expires_at,total_cents FROM orders WHERE id=$1 AND user_id=$2',
    [req.params.id, req.user.id],
  );
  if (!order) return res.sendStatus(404);
  const reservationActive = order.status === 'pending_payment' && new Date(order.reservation_expires_at).getTime() > Date.now();
  const canStartPayment = reservationActive && (!order.payment_id || ['rejected', 'cancelled'].includes(order.payment_status));
  let payment = null;
  if (order.payment_id) {
    const currentPayment = await getPayment(order.payment_id);
    if (currentPayment.external_reference !== order.id || String(currentPayment.id) !== String(order.payment_id)) {
      console.error(`[aether] Payment lookup did not match order ${order.id}.`);
      return res.status(502).json({ error: 'Não foi possível consultar o pagamento agora.' });
    }
    payment = directPaymentDto(currentPayment);
  }
  const canResumePayment = canStartPayment || (reservationActive && payment?.paymentMethod === 'pix' && payment.status === 'pending');
  res.json({
    orderId: order.id,
    totalCents: Number(order.total_cents),
    reservationExpiresAt: order.reservation_expires_at,
    canResumePayment,
    canStartPayment,
    paymentMethod: order.payment_attempt_method,
    idempotencyKey: canStartPayment ? order.payment_attempt_key : null,
    payment: canResumePayment && payment?.paymentMethod === 'pix' ? payment : null,
  });
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
      if (order.payment_id && order.payment_id !== paymentId && !['rejected', 'cancelled'].includes(order.payment_status)) {
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
             fulfillment_status = CASE WHEN $3='approved' AND fulfillment_status='not_paid' THEN 'processing' ELSE fulfillment_status END,
             payment_id = CASE WHEN $4 THEN $5 ELSE payment_id END,
             payment_attempt_key = CASE WHEN $3 IN ('rejected', 'cancelled') THEN NULL ELSE payment_attempt_key END,
             payment_attempt_method = CASE WHEN $3 IN ('rejected', 'cancelled') THEN NULL ELSE payment_attempt_method END,
             refunded_cents = GREATEST(refunded_cents, $6),
             updated_at = NOW()
         WHERE id = $1`,
        [orderId, nextOrderStatus, paymentState.paymentStatus, bindsPaymentId, paymentId, paymentState.refundedCents],
      );

      if (order.payment_status !== paymentState.paymentStatus || order.status !== nextOrderStatus) {
        const { rows: [customer] } = await client.query('SELECT email, name FROM users WHERE id=$1', [order.user_id]);
        const statusLabels = {
          approved: 'Pagamento aprovado', authorized: 'Pagamento autorizado', in_process: 'Pagamento em análise',
          in_mediation: 'Pagamento em contestação', rejected: 'Pagamento recusado', cancelled: 'Pagamento cancelado',
          refunded: 'Pagamento reembolsado', partially_refunded: 'Pagamento parcialmente reembolsado',
          charged_back: 'Pagamento contestado (chargeback)', unknown: 'Status de pagamento desconhecido',
        };
        await enqueueEmail(client, {
          eventKey: `payment-update:${paymentId}:${paymentState.paymentStatus}:${paymentState.refundedCents}`,
          recipient: customer.email,
          template: 'payment-update',
          payload: {
            name: customer.name,
            orderId,
            totalCents: order.total_cents,
            paymentStatus: paymentState.paymentStatus,
            refundedCents: paymentState.refundedCents,
            statusLabel: statusLabels[paymentState.paymentStatus] || statusLabels.unknown,
          },
        });
      }
    });
    res.sendStatus(200);
  } catch (error) {
    if (error.status === 404) {
      console.warn(`[aether] Mercado Pago payment ${dataId} was not found; acknowledging webhook without changing the order.`);
      return res.sendStatus(200);
    }
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
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8::text, $9::boolean) RETURNING *`,
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
       compare_at_cents=$6, stock=$7, image_url=$8::text, active=$9::boolean,
       featured_position=CASE WHEN $9::boolean=TRUE AND $8::text IS NOT NULL THEN featured_position ELSE NULL END,
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

app.delete('/api/admin/products/:id/permanent', requireUser, requireAdmin, async (req, res) => {
  const removed = await inTransaction(async (client) => {
    const { rows: [product] } = await client.query('SELECT image_url FROM products WHERE id=$1 FOR UPDATE', [req.params.id]);
    if (!product) return null;
    await client.query('DELETE FROM products WHERE id=$1', [req.params.id]);
    if (!product.image_url || !/^\/uploads\/[\w-]+\.(jpg|png|webp)$/i.test(product.image_url)) return null;
    const { rows: [otherReference] } = await client.query('SELECT 1 FROM products WHERE image_url=$1 LIMIT 1', [product.image_url]);
    return otherReference ? null : path.basename(product.image_url);
  });
  if (removed === null) {
    const { rowCount } = await pool.query('SELECT 1 FROM products WHERE id=$1', [req.params.id]);
    if (rowCount) return res.status(404).json({ error: 'Figure nao encontrada.' });
  }
  if (removed) {
    try { await unlink(path.join(uploadsDir, removed)); }
    catch (error) { if (error.code !== 'ENOENT') console.error('[aether] Could not remove unreferenced product image.'); }
  }
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
    hasPayment: Boolean(order.payment_id),
    hasPaymentAttempt: Boolean(order.payment_attempt_key),
  })));
});

app.put('/api/admin/orders/:id/fulfillment', requireUser, requireAdmin, async (req, res) => {
  const data = parse(z.object({
    status: z.enum(['processing', 'shipped', 'delivered']),
    trackingCode: z.string().trim().max(100).optional().default(''),
  }), req.body);
  const updated = await inTransaction(async (client) => {
    const { rows: [order] } = await client.query(
      `SELECT o.*, u.email AS customer_email, u.name AS customer_name
       FROM orders o JOIN users u ON o.user_id=u.id WHERE o.id=$1 FOR UPDATE OF o`,
      [req.params.id],
    );
    if (!order) { const error = new Error('Order not found.'); error.status = 404; throw error; }
    if (order.status !== 'paid' || order.payment_status !== 'approved') {
      const error = new Error('Only paid orders can have their fulfillment stage changed.'); error.status = 409; throw error;
    }
    if (order.fulfillment_status === data.status) return order;
    if (data.status === 'shipped' && !data.trackingCode && !order.tracking_code) {
      const error = new Error('A tracking code is required before marking an order as shipped.'); error.status = 400; throw error;
    }
    const { rows: [saved] } = await client.query(
      "UPDATE orders SET fulfillment_status=$2, tracking_code=COALESCE(NULLIF($3, ''), tracking_code), updated_at=NOW() WHERE id=$1 RETURNING *",
      [order.id, data.status, data.trackingCode || null],
    );
    const statusLabel = { processing: 'Pedido em separa\u00e7\u00e3o', shipped: 'Pedido enviado', delivered: 'Pedido entregue' }[data.status];
    await enqueueEmail(client, {
      eventKey: `fulfillment-update:${order.id}:${randomUUID()}`,
      recipient: order.customer_email,
      template: 'fulfillment-update',
      payload: { name: order.customer_name, orderId: order.id, statusLabel, trackingCode: saved.tracking_code },
    });
    return saved;
  });
  res.json({ fulfillmentStatus: updated.fulfillment_status, trackingCode: updated.tracking_code || null });
});

app.post('/api/admin/orders/:id/cancel', requireUser, requireAdmin, async (req, res) => {
  const cancelled = await inTransaction(async (client) => {
    const { rows: [order] } = await client.query(
      `SELECT o.*, u.email AS customer_email, u.name AS customer_name
       FROM orders o JOIN users u ON o.user_id=u.id WHERE o.id=$1 FOR UPDATE OF o`,
      [req.params.id],
    );
    if (!order) { const error = new Error('Order not found.'); error.status = 404; throw error; }
    if (order.status === 'cancelled') return order;
    if (!['pending_payment', 'expired', 'checkout_error'].includes(order.status) || order.payment_id || order.payment_attempt_key || order.payment_status !== 'pending') {
      const error = new Error('Only unpaid orders without a payment attempt can be cancelled.'); error.status = 409; throw error;
    }
    if (order.status === 'pending_payment') {
      await client.query(
        `UPDATE products p SET stock=p.stock+reserved.quantity, updated_at=NOW()
         FROM (SELECT product_id,SUM(quantity)::INTEGER AS quantity FROM order_items WHERE order_id=$1 AND product_id IS NOT NULL GROUP BY product_id) reserved
         WHERE p.id=reserved.product_id`,
        [order.id],
      );
    }
    const { rows: [saved] } = await client.query("UPDATE orders SET status='cancelled', updated_at=NOW() WHERE id=$1 RETURNING *", [order.id]);
    await enqueueEmail(client, {
      eventKey: `order-cancelled:${order.id}`, recipient: order.customer_email, template: 'order-cancelled',
      payload: { name: order.customer_name, orderId: order.id, totalCents: Number(order.total_cents) },
    });
    return saved;
  });
  res.json({ status: cancelled.status });
});

app.delete('/api/admin/orders/:id', requireUser, requireAdmin, async (req, res) => {
  const deleted = await inTransaction(async (client) => {
    const { rows: [order] } = await client.query('SELECT status,payment_id,payment_attempt_key FROM orders WHERE id=$1 FOR UPDATE', [req.params.id]);
    if (!order) return false;
    if (!['cancelled', 'expired', 'checkout_error'].includes(order.status) || order.payment_id || order.payment_attempt_key) {
      const error = new Error('Only closed orders without a payment can be deleted.');
      error.status = 409; throw error;
    }
    await client.query('DELETE FROM orders WHERE id=$1', [req.params.id]);
    return true;
  });
  if (!deleted) return res.sendStatus(404);
  res.sendStatus(204);
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
  console.error(`[aether] Request failed (${_req.method} ${_req.path}):`, error.message);
  res.status(500).json({ error: 'Não foi possível concluir a solicitação agora.' });
});

async function start() {
  await migrate();
  await bootstrapAdmin();
  startEmailWorker(pool);
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
