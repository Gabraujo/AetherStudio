import bcrypt from 'bcryptjs';
import { pool } from './db.js';

export const normalizeEmail = (email) => email.trim().toLowerCase();

export async function bootstrapAdmin() {
  const email = process.env.ADMIN_EMAIL ? normalizeEmail(process.env.ADMIN_EMAIL) : '';
  if (!email) {
    console.warn('[aether] ADMIN_EMAIL não configurado; painel administrativo desativado.');
    return;
  }
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    throw new Error('ADMIN_EMAIL precisa ser um endereço de e-mail válido.');
  }

  const existing = await pool.query('SELECT id, is_admin FROM users WHERE email = $1', [email]);
  const password = process.env.ADMIN_BOOTSTRAP_PASSWORD;

  if ((!existing.rowCount || !existing.rows[0].is_admin) && !password) {
    console.warn('[aether] Configure ADMIN_BOOTSTRAP_PASSWORD para criar a conta administradora.');
    return;
  }
  if (password && (password.length < 14 || Buffer.byteLength(password, 'utf8') > 72)) {
    throw new Error('ADMIN_BOOTSTRAP_PASSWORD precisa ter entre 14 e 72 bytes.');
  }

  if (existing.rowCount) {
    if (!existing.rows[0].is_admin) {
      const passwordHash = await bcrypt.hash(password, 12);
      await pool.query('UPDATE users SET password_hash = $2, is_admin = TRUE WHERE id = $1', [existing.rows[0].id, passwordHash]);
    }
    await pool.query('UPDATE users SET is_admin = FALSE WHERE is_admin = TRUE AND email <> $1', [email]);
    return;
  }

  const passwordHash = await bcrypt.hash(password, 12);
  await pool.query(
    `INSERT INTO users (id, email, name, password_hash, is_admin)
     VALUES (gen_random_uuid(), $1, 'Aether Admin', $2, TRUE)
     ON CONFLICT (email) DO UPDATE SET is_admin = TRUE`,
    [email, passwordHash],
  );
  console.info(`[aether] Conta administradora preparada para ${email}.`);
}

export async function loadSessionUser(req, _res, next) {
  try {
    const userId = req.session?.userId;
    if (!userId) return next();

    const { rows } = await pool.query(
      'SELECT id, email, name, is_admin, created_at FROM users WHERE id = $1',
      [userId],
    );
    req.user = rows[0] || null;
    if (!req.user) req.session.destroy(() => {});
    next();
  } catch (error) {
    next(error);
  }
}

export function requireUser(req, res, next) {
  if (!req.user) return res.status(401).json({ error: 'Entre na sua conta para continuar.' });
  next();
}

export function requireAdmin(req, res, next) {
  const configuredEmail = process.env.ADMIN_EMAIL ? normalizeEmail(process.env.ADMIN_EMAIL) : '';
  if (!req.user || !configuredEmail || req.user.email !== configuredEmail || !req.user.is_admin) {
    return res.status(403).json({ error: 'Acesso restrito à conta administradora.' });
  }
  next();
}

export const publicUser = (user) => ({
  id: user.id,
  email: user.email,
  name: user.name,
  isAdmin: Boolean(user.is_admin),
  createdAt: user.created_at,
});
