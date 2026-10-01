import { createHmac, timingSafeEqual } from 'node:crypto';

const API_ROOT = 'https://api.mercadopago.com';

export async function createCheckoutPreference({ order, items, buyer, shippingAddress, paymentMethod }) {
  const accessToken = process.env.MP_ACCESS_TOKEN;
  const appUrl = process.env.APP_URL?.replace(/\/$/, '');
  if (!accessToken || !appUrl) {
    const error = new Error('Checkout indisponível: configure Mercado Pago e domínio público no servidor.');
    error.status = 503;
    throw error;
  }
  if (process.env.NODE_ENV === 'production' && !appUrl.startsWith('https://')) {
    const error = new Error('APP_URL precisa usar HTTPS em produção.');
    error.status = 503;
    throw error;
  }

  const preferenceStartsAt = new Date(Date.now() - 1_000).toISOString();
  const preferenceExpiresAt = new Date(order.reservation_expires_at).toISOString();
  if (!Number.isFinite(Date.parse(preferenceExpiresAt)) || Date.parse(preferenceExpiresAt) <= Date.now()) {
    const error = new Error('A reserva do pedido expirou antes da abertura do pagamento.');
    error.status = 409;
    throw error;
  }

  const response = await fetch(`${API_ROOT}/checkout/preferences`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${accessToken}`,
      'Content-Type': 'application/json',
      'X-Idempotency-Key': order.id,
    },
    body: JSON.stringify({
      expires: true,
      expiration_date_from: preferenceStartsAt,
      expiration_date_to: preferenceExpiresAt,
      external_reference: order.id,
      items: items.map((item) => ({
        id: item.product_id,
        title: item.product_name,
        quantity: item.quantity,
        currency_id: 'BRL',
        unit_price: item.unit_price_cents / 100,
      })),
      payer: { email: buyer.email, name: buyer.name },
      ...(paymentMethod === 'pix' ? { payment_methods: { default_payment_method_id: 'pix' } } : {}),
      shipments: {
        receiver_address: {
          street_name: shippingAddress.street,
          street_number: shippingAddress.number,
          zip_code: shippingAddress.postalCode,
          city_name: shippingAddress.city,
          state_name: shippingAddress.state,
        },
      },
      back_urls: {
        success: `${appUrl}/?pagamento=sucesso#conta`,
        pending: `${appUrl}/?pagamento=pendente#conta`,
        failure: `${appUrl}/?pagamento=falhou#conta`,
      },
      auto_return: 'approved',
      notification_url: `${appUrl}/api/payments/webhook`,
      statement_descriptor: 'AETHER FIGURES',
      metadata: { order_id: order.id },
    }),
    signal: AbortSignal.timeout(12_000),
  });

  const result = await response.json().catch(() => ({}));
  if (!response.ok || !result.id || !result.init_point) {
    console.error(`[aether] Mercado Pago preference rejected (${response.status}).`);
    const error = new Error('Não foi possível iniciar o pagamento. Tente novamente em instantes.');
    error.status = 502;
    throw error;
  }
  return { id: result.id, url: result.init_point };
}

export function verifyWebhookSignature({ signature, requestId, dataId, secret }) {
  if (!signature || !requestId || !dataId || !secret) return false;
  const parts = Object.fromEntries(signature.split(',').map((part) => part.trim().split('=')));
  if (!parts.ts || !parts.v1) return false;

  const manifest = `id:${dataId.toLowerCase()};request-id:${requestId};ts:${parts.ts};`;
  const expected = createHmac('sha256', secret).update(manifest).digest();
  let received;
  try {
    received = Buffer.from(parts.v1, 'hex');
  } catch {
    return false;
  }
  return received.length === expected.length && timingSafeEqual(received, expected);
}

export async function getPayment(paymentId) {
  const response = await fetch(`${API_ROOT}/v1/payments/${encodeURIComponent(paymentId)}`, {
    headers: { Authorization: `Bearer ${process.env.MP_ACCESS_TOKEN}` },
    signal: AbortSignal.timeout(10_000),
  });
  if (!response.ok) throw new Error(`Mercado Pago payment lookup failed (${response.status}).`);
  return response.json();
}
