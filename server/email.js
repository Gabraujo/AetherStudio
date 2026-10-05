import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const RESEND_API_URL = 'https://api.resend.com/emails';
const logoPath = fileURLToPath(new URL('../public/icons/aether-192.png', import.meta.url));
const logoAttachment = {
  filename: 'aether-logo.png',
  content: readFileSync(logoPath).toString('base64'),
  content_id: 'aether-logo',
  content_type: 'image/png',
};

export const emailEnabled = () => Boolean(process.env.RESEND_API_KEY && process.env.EMAIL_FROM);

function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, (character) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  })[character]);
}

const brl = (cents) => (Number(cents) / 100).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });

function emailLayout(title, body) {
  const safeTitle = escapeHtml(title);
  return `<!doctype html><html lang="pt-BR"><body style="margin:0;background:#0b0a09;color:#e7dfd3;font-family:Arial,sans-serif"><div style="max-width:600px;margin:32px auto;padding:32px 24px;background:#171311;border:1px solid #302a24"><p style="margin:0 0 24px"><img src="cid:aether-logo" width="72" height="72" alt="Aether" style="display:block;width:72px;height:72px;object-fit:contain"></p><h1 style="font-family:Georgia,serif;font-weight:400;color:#ead9c4">${safeTitle}</h1>${body}<p style="margin-top:32px;color:#948d85;font-size:13px">Aether Studio · <a style="color:#d6bc98" href="${escapeHtml(process.env.APP_URL || '')}">aetherstudio3d.com</a></p></div></body></html>`;
}

function renderEmail(template, payload) {
  const name = escapeHtml(payload.name || 'cliente');
  const orderId = escapeHtml(String(payload.orderId || '').slice(0, 8).toUpperCase());
  const total = brl(payload.totalCents);

  if (template === 'password-reset') {
    const url = escapeHtml(payload.url);
    return {
      subject: 'Redefina sua senha · Aether Studio',
      text: `Olá, ${payload.name}. Para criar uma nova senha, acesse: ${payload.url}\nO link expira em 30 minutos. Se você não pediu a redefinição, ignore este e-mail.`,
      html: emailLayout('Redefina sua senha', `<p>Olá, ${name}. Recebemos uma solicitação para trocar a senha da sua conta.</p><p><a href="${url}" style="display:inline-block;padding:14px 20px;background:#d6bc98;color:#17120e;text-decoration:none">Criar nova senha</a></p><p>Este link expira em 30 minutos e só pode ser usado uma vez. Se você não pediu a redefinição, ignore este e-mail.</p>`),
    };
  }

  if (template === 'order-created') {
    const url = escapeHtml(payload.accountUrl || `${process.env.APP_URL}/#conta`);
    return {
      subject: `Pedido ${orderId} recebido · Aether Studio`,
      text: `Olá, ${payload.name}. Recebemos seu pedido ${orderId}, no total de ${total}. Ele aguarda o pagamento. Acesse sua conta para continuar: ${payload.accountUrl}`,
      html: emailLayout('Pedido recebido', `<p>Olá, ${name}. Seu pedido <strong>#${orderId}</strong> foi criado e aguarda o pagamento.</p><p>Total: <strong>${total}</strong></p><p><a href="${url}" style="display:inline-block;padding:14px 20px;background:#d6bc98;color:#17120e;text-decoration:none">Acompanhar pedido</a></p>`),
    };
  }

  if (template === 'order-cancelled') {
    return {
      subject: `Pedido ${orderId} cancelado - Aether Studio`,
      text: `Ol\u00e1, ${payload.name}. O pedido ${orderId} foi cancelado. Se precisar de ajuda, entre em contato conosco.`,
      html: emailLayout('Pedido cancelado', `<p>Ol\u00e1, ${name}. O pedido <strong>#${orderId}</strong> foi cancelado.</p><p>Se precisar de ajuda, entre em contato conosco.</p>`),
    };
  }

  if (template === 'payment-update') {
    const status = escapeHtml(payload.statusLabel);
    const refunded = payload.refundedCents > 0 ? `<p>Valor reembolsado: <strong>${brl(payload.refundedCents)}</strong></p>` : '';
    return {
      subject: `Atualização do pedido ${orderId} · Aether Studio`,
      text: `Olá, ${payload.name}. O pagamento do pedido ${orderId} está com o status: ${payload.statusLabel}. Valor: ${total}. Acompanhe em ${process.env.APP_URL}/#conta.`,
      html: emailLayout('Atualização do pagamento', `<p>Olá, ${name}. O pagamento do pedido <strong>#${orderId}</strong> foi atualizado.</p><p>Status: <strong>${status}</strong></p><p>Total: <strong>${total}</strong></p>${refunded}<p>Acompanhe seus pedidos na sua conta da loja.</p>`),
    };
  }

  if (template === 'fulfillment-update') {
    const status = escapeHtml(payload.statusLabel);
    const tracking = payload.trackingCode ? `<p>Código de rastreio: <strong>${escapeHtml(payload.trackingCode)}</strong></p>` : '';
    return {
      subject: `Seu pedido ${orderId} foi atualizado · Aether Studio`,
      text: `Olá, ${payload.name}. O pedido ${orderId} está agora: ${payload.statusLabel}.${payload.trackingCode ? ` Código de rastreio: ${payload.trackingCode}.` : ''} Acompanhe em ${process.env.APP_URL}/#conta.`,
      html: emailLayout('Atualização do pedido', `<p>Olá, ${name}. O pedido <strong>#${orderId}</strong> foi atualizado.</p><p>Status: <strong>${status}</strong></p>${tracking}<p>Acompanhe seus pedidos na sua conta da loja.</p>`),
    };
  }

  throw new Error(`Unknown transactional email template: ${template}`);
}

export async function sendTransactionalEmail({ recipient, template, payload, idempotencyKey }) {
  if (!emailEnabled()) throw new Error('Transactional email is not configured.');
  const message = renderEmail(template, payload);
  const response = await fetch(RESEND_API_URL, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${process.env.RESEND_API_KEY}`,
      'Content-Type': 'application/json',
      'Idempotency-Key': idempotencyKey,
    },
    body: JSON.stringify({ from: process.env.EMAIL_FROM, to: [recipient], attachments: [logoAttachment], ...message }),
    signal: AbortSignal.timeout(10_000),
  });
  if (!response.ok) throw new Error(`Resend returned HTTP ${response.status}.`);
}

export async function enqueueEmail(client, { eventKey, recipient, template, payload }) {
  if (!emailEnabled()) return;
  await client.query(
    `INSERT INTO email_outbox (id, event_key, recipient, template, payload)
     VALUES (gen_random_uuid(), $1, $2, $3, $4)
     ON CONFLICT (event_key) DO NOTHING`,
    [eventKey, recipient, template, JSON.stringify(payload)],
  );
}

export function startEmailWorker(pool) {
  let active = false;
  const timer = setInterval(async () => {
    if (active || !emailEnabled()) return;
    active = true;
    try {
      const client = await pool.connect();
      let message;
      try {
        await client.query('BEGIN');
        const { rows } = await client.query(
          `WITH candidate AS (
             SELECT id FROM email_outbox
             WHERE (status = 'pending' AND available_at <= NOW())
                OR (status = 'sending' AND locked_until < NOW())
             ORDER BY created_at
             FOR UPDATE SKIP LOCKED
             LIMIT 1
           )
           UPDATE email_outbox AS queue
           SET status = 'sending', attempts = attempts + 1,
               locked_until = NOW() + INTERVAL '1 minute'
           FROM candidate
           WHERE queue.id = candidate.id
           RETURNING queue.*`,
        );
        message = rows[0];
        await client.query('COMMIT');
      } catch (error) {
        await client.query('ROLLBACK');
        throw error;
      } finally {
        client.release();
      }

      if (!message) return;
      try {
        await sendTransactionalEmail({
          recipient: message.recipient,
          template: message.template,
          payload: message.payload,
          idempotencyKey: message.event_key,
        });
        await pool.query(
          "UPDATE email_outbox SET status='sent', sent_at=NOW(), locked_until=NULL, last_error=NULL WHERE id=$1",
          [message.id],
        );
      } catch (error) {
        const exhausted = message.attempts >= 8;
        const retrySeconds = Math.min(3600, 15 * (2 ** Math.min(message.attempts - 1, 8)));
        await pool.query(
          `UPDATE email_outbox
           SET status=$2, locked_until=NULL, available_at=NOW() + ($3 * INTERVAL '1 second'), last_error=$4
           WHERE id=$1`,
          [message.id, exhausted ? 'dead' : 'pending', retrySeconds, error.message.slice(0, 300)],
        );
        console.error(`[aether] Transactional email ${message.id} failed (attempt ${message.attempts}).`);
      }
    } catch (error) {
      console.error('[aether] Email outbox worker failed:', error.message);
    } finally {
      active = false;
    }
  }, 5_000);
  timer.unref();
  return () => clearInterval(timer);
}
