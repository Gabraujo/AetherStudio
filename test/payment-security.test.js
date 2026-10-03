import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import test from 'node:test';
import { verifyWebhookSignature, validateCheckoutUrl } from '../server/mercado-pago.js';
import { derivePaymentState } from '../server/payment-state.js';

test('accepts official Mercado Pago checkout domains over HTTPS', () => {
  assert.equal(validateCheckoutUrl('https://www.mercadopago.com.br/checkout?pref_id=1'), 'https://www.mercadopago.com.br/checkout?pref_id=1');
  assert.equal(validateCheckoutUrl('https://sandbox.mercadopago.com/checkout?pref_id=1'), 'https://sandbox.mercadopago.com/checkout?pref_id=1');
});

test('rejects checkout URLs outside Mercado Pago or with unsafe URL components', () => {
  for (const url of [
    'http://www.mercadopago.com.br/checkout',
    'https://mercadopago.com.br.attacker.example/checkout',
    'https://attacker@www.mercadopago.com.br/checkout',
    'https://www.mercadopago.com.br:8443/checkout',
    'not-a-url',
  ]) assert.throws(() => validateCheckoutUrl(url));
});

test('verifies Mercado Pago webhook HMAC and rejects malformed or altered signatures', () => {
  const secret = 'local-test-webhook-secret';
  const requestId = 'request-123';
  const dataId = '987654321';
  const timestamp = '1780000000';
  const manifest = `id:${dataId};request-id:${requestId};ts:${timestamp};`;
  const signature = createHmac('sha256', secret).update(manifest).digest('hex');
  const args = { signature: `ts=${timestamp},v1=${signature}`, requestId, dataId, secret };

  assert.equal(verifyWebhookSignature(args), true);
  assert.equal(verifyWebhookSignature({ ...args, dataId: '987654322' }), false);
  assert.equal(verifyWebhookSignature({ ...args, signature: `ts=${timestamp},v1=${signature},v1=${signature}` }), false);
  assert.equal(verifyWebhookSignature({ ...args, signature: `ts=${timestamp},v1=xyz` }), false);
});

test('maps approved, rejected, mediation, refund, and chargeback states safely', () => {
  assert.deepEqual(derivePaymentState({ status: 'approved', transaction_amount_refunded: 0 }, 12500), {
    paymentStatus: 'approved', refundedCents: 0,
  });
  assert.deepEqual(derivePaymentState({ status: 'rejected', transaction_amount_refunded: 0 }, 12500), {
    paymentStatus: 'rejected', refundedCents: 0,
  });
  assert.deepEqual(derivePaymentState({ status: 'in_mediation', transaction_amount_refunded: 0 }, 12500), {
    paymentStatus: 'in_mediation', refundedCents: 0,
  });
  assert.deepEqual(derivePaymentState({ status: 'approved', transaction_amount_refunded: 35 }, 12500), {
    paymentStatus: 'partially_refunded', refundedCents: 3500,
  });
  assert.deepEqual(derivePaymentState({ status: 'refunded', transaction_amount_refunded: 125 }, 12500), {
    paymentStatus: 'refunded', refundedCents: 12500,
  });
  assert.deepEqual(derivePaymentState({ status: 'charged_back', transaction_amount_refunded: 0 }, 12500), {
    paymentStatus: 'charged_back', refundedCents: 0,
  });
});

test('flags unknown statuses and rejects inconsistent refunded amounts', () => {
  assert.deepEqual(derivePaymentState({ status: 'future_status', transaction_amount_refunded: 0 }, 10000), {
    paymentStatus: 'unknown', refundedCents: 0,
  });
  assert.equal(derivePaymentState({ status: 'partially_refunded', transaction_amount_refunded: 0 }, 10000), null);
  assert.equal(derivePaymentState({ status: 'approved', transaction_amount_refunded: 101 }, 10000), null);
  assert.equal(derivePaymentState({ status: 'approved', transaction_amount_refunded: -1 }, 10000), null);
});
