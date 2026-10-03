const PAYMENT_STATUSES = new Set([
  'pending',
  'approved',
  'authorized',
  'in_process',
  'in_mediation',
  'rejected',
  'cancelled',
  'refunded',
  'partially_refunded',
  'charged_back',
]);

export function derivePaymentState(payment, totalCents) {
  const sourceStatus = PAYMENT_STATUSES.has(payment.status) ? payment.status : 'unknown';
  const refundedAmount = Number(payment.transaction_amount_refunded ?? 0);
  if (!Number.isFinite(refundedAmount) || refundedAmount < 0) return null;

  let refundedCents = Math.round(refundedAmount * 100);
  if (refundedCents > totalCents) return null;

  if (sourceStatus === 'refunded') {
    refundedCents = totalCents;
    return { paymentStatus: 'refunded', refundedCents };
  }

  if (sourceStatus === 'partially_refunded' || (sourceStatus === 'approved' && refundedCents > 0)) {
    if (refundedCents === totalCents) return { paymentStatus: 'refunded', refundedCents };
    if (refundedCents === 0) return null;
    return { paymentStatus: 'partially_refunded', refundedCents };
  }

  return { paymentStatus: sourceStatus, refundedCents };
}
