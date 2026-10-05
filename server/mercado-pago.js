import { createHmac, timingSafeEqual } from 'node:crypto';

const API_ROOT = 'https://api.mercadopago.com';

export function validateCheckoutUrl(value) {
  let checkoutUrl;
  try {
    checkoutUrl = new URL(value);
  } catch {
    throw new Error('Mercado Pago returned an invalid checkout URL.');
  }
  const isMercadoPagoHost = checkoutUrl.hostname === 'mercadopago.com'
    || checkoutUrl.hostname.endsWith('.mercadopago.com')
    || checkoutUrl.hostname === 'mercadopago.com.br'
    || checkoutUrl.hostname.endsWith('.mercadopago.com.br');
  if (checkoutUrl.protocol !== 'https:' || checkoutUrl.username || checkoutUrl.password || checkoutUrl.port
    || !isMercadoPagoHost) {
    throw new Error('Mercado Pago returned an untrusted checkout URL.');
  }
  return checkoutUrl.href;
}

export async function createCheckoutPreference({ order, items, buyer, shippingAddress, paymentMethod }) {
  const accessToken = process.env.MP_ACCESS_TOKEN;
  let appUrl;
  try {
    const configuredUrl = new URL(process.env.APP_URL || '');
    if (configuredUrl.username || configuredUrl.password || configuredUrl.pathname !== '/' || configuredUrl.search || configuredUrl.hash) {
      throw new Error('APP_URL must contain only the public origin.');
    }
    appUrl = configuredUrl.origin;
  } catch {
    const error = new Error('APP_URL precisa ser uma URL pública válida.');
    error.status = 503;
    throw error;
  }
  if (!accessToken || !appUrl) {
    const error = new Error('A finalização online está temporariamente indisponível. Tente novamente mais tarde.');
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
  return { id: result.id, url: validateCheckoutUrl(result.init_point) };
}

export async function createDirectPayment({ orderId, totalCents, buyer, payment, notificationUrl, idempotencyKey }) {
  const accessToken = process.env.MP_ACCESS_TOKEN;
  if (!accessToken) {
    const error = new Error('O pagamento está temporariamente indisponível. Tente novamente mais tarde.');
    error.status = 503;
    throw error;
  }

  const paymentMethodId = payment.paymentMethod === 'pix' ? 'pix' : payment.paymentMethodId;
  const body = {
    transaction_amount: totalCents / 100,
    description: `Pedido Aether ${orderId.slice(0, 8).toUpperCase()}`,
    payment_method_id: paymentMethodId,
    payer: {
      email: buyer.email,
      ...(payment.identification ? { identification: payment.identification } : {}),
    },
    external_reference: orderId,
    notification_url: notificationUrl,
    statement_descriptor: 'AETHER FIGURES',
    metadata: { order_id: orderId },
    ...(payment.paymentMethod === 'pix'
      ? { date_of_expiration: payment.expirationAt }
      : {
        token: payment.token,
        installments: payment.installments,
        ...(payment.issuerId ? { issuer_id: Number(payment.issuerId) } : {}),
      }),
  };

  const headers = {
    Authorization: `Bearer ${accessToken}`,
    'Content-Type': 'application/json',
    'X-Idempotency-Key': idempotencyKey,
  };
  const deviceId = payment.deviceId;
  if (deviceId) headers['X-meli-session-id'] = deviceId;

  const response = await fetch(`${API_ROOT}/v1/payments`, {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(15_000),
  });
  const result = await response.json().catch(() => ({}));
  if (!response.ok || !result.id || !result.status) {
    const safeProviderDetails = {
      message: typeof result.message === 'string' ? result.message.slice(0, 200) : undefined,
      cause: Array.isArray(result.cause) ? result.cause.slice(0, 5).map((item) => ({
        code: typeof item.code === 'string' ? item.code.slice(0, 80) : undefined,
        description: typeof item.description === 'string' ? item.description.slice(0, 200) : undefined,
      })) : undefined,
    };
    console.error(`[aether] Mercado Pago direct payment rejected (${response.status}): ${JSON.stringify(safeProviderDetails)}`);
    const error = new Error('Não foi possível confirmar o pagamento. Confira os dados e tente novamente.');
    error.status = response.status >= 400 && response.status < 500 ? 422 : 502;
    throw error;
  }

  return {
    id: String(result.id),
    status: result.status,
    statusDetail: result.status_detail || null,
    externalReference: result.external_reference,
    transactionAmount: Number(result.transaction_amount),
    currencyId: result.currency_id,
    liveMode: result.live_mode,
    paymentMethodId: result.payment_method_id,
    qrCode: result.point_of_interaction?.transaction_data?.qr_code || null,
    qrCodeBase64: result.point_of_interaction?.transaction_data?.qr_code_base64 || null,
    ticketUrl: result.point_of_interaction?.transaction_data?.ticket_url || null,
    expirationDate: result.date_of_expiration || null,
  };
}

export function verifyWebhookSignature({ signature, requestId, dataId, secret }) {
  if (!signature || !requestId || !dataId || !secret) return false;
  const parts = new Map();
  for (const entry of signature.split(',')) {
    const separator = entry.indexOf('=');
    if (separator < 1) return false;
    const key = entry.slice(0, separator).trim().toLowerCase();
    const value = entry.slice(separator + 1).trim();
    if ((key === 'ts' || key === 'v1') && parts.has(key)) return false;
    if (key === 'ts' || key === 'v1') parts.set(key, value);
  }
  const timestamp = parts.get('ts');
  const signatureHex = parts.get('v1');
  if (!/^\d{1,16}$/.test(timestamp || '') || !/^[a-f\d]{64}$/i.test(signatureHex || '')) return false;

  const manifest = `id:${dataId.toLowerCase()};request-id:${requestId};ts:${timestamp};`;
  const expected = createHmac('sha256', secret).update(manifest).digest();
  const received = Buffer.from(signatureHex, 'hex');
  return received.length === expected.length && timingSafeEqual(received, expected);
}

export async function getPayment(paymentId) {
  const response = await fetch(`${API_ROOT}/v1/payments/${encodeURIComponent(paymentId)}`, {
    headers: { Authorization: `Bearer ${process.env.MP_ACCESS_TOKEN}` },
    signal: AbortSignal.timeout(10_000),
  });
  if (!response.ok) {
    const error = new Error(`Mercado Pago payment lookup failed (${response.status}).`);
    error.status = response.status;
    throw error;
  }
  return response.json();
}
