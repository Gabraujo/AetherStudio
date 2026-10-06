import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { CardPayment, initMercadoPago } from '@mercadopago/sdk-react';
import { api } from './api.js';

const statusText = {
  approved: 'Pagamento aprovado. Seu pedido já está confirmado.',
  pending: 'Aguardando a confirmação do pagamento.',
  in_process: 'O Mercado Pago está analisando o pagamento.',
  authorized: 'Pagamento autorizado e em processamento.',
};

export default function CheckoutPayment({ order, publicKey, email, onPaid, initialPayment, initialPaymentMethod, idempotencyKey }) {
  const [sdkReady, setSdkReady] = useState(false);
  const [cardBrickReady, setCardBrickReady] = useState(false);
  const [cardLoadError, setCardLoadError] = useState('');
  const [cardAttempt, setCardAttempt] = useState(0);
  const [method, setMethod] = useState(initialPayment?.paymentMethod === 'pix' || initialPaymentMethod === 'pix' ? 'pix' : initialPaymentMethod || 'pix');
  const [pix, setPix] = useState(initialPayment?.paymentMethod === 'pix' && initialPayment.status === 'pending' ? initialPayment : null);
  const [message, setMessage] = useState('');
  const [busy, setBusy] = useState(false);
  const attemptKeys = useRef(idempotencyKey && initialPaymentMethod ? { [initialPaymentMethod]: idempotencyKey } : {});
  const onPaidRef = useRef(onPaid);
  onPaidRef.current = onPaid;
  const cardBrickReadyRef = useRef(false);
  cardBrickReadyRef.current = cardBrickReady;
  const cardInitialization = useMemo(() => ({ amount: order.totalCents / 100, payer: { email } }), [order.totalCents, email]);
  const cardCustomization = useMemo(() => ({ paymentMethods: { maxInstallments: 12 } }), []);

  useEffect(() => {
    if (!publicKey) return;
    initMercadoPago(publicKey, { locale: 'pt-BR' });
    setSdkReady(true);
  }, [publicKey]);

  useEffect(() => {
    const script = document.createElement('script');
    script.src = 'https://www.mercadopago.com/v2/security.js';
    script.setAttribute('view', 'checkout');
    script.async = true;
    document.head.appendChild(script);
    return () => script.remove();
  }, []);

  const attemptKey = useCallback((paymentMethod) => {
    if (attemptKeys.current[paymentMethod]) return attemptKeys.current[paymentMethod];
    const key = crypto.randomUUID();
    attemptKeys.current[paymentMethod] = key;
    return key;
  }, []);

  const submit = useCallback(async (paymentMethod, formData) => {
    setBusy(true);
    setMessage('');
    try {
      const result = await api(`/api/orders/${order.orderId}/payment`, {
        method: 'POST',
        body: {
          idempotencyKey: attemptKey(paymentMethod),
          paymentMethod,
          ...(window.MP_DEVICE_SESSION_ID ? { deviceId: window.MP_DEVICE_SESSION_ID } : {}),
          ...(formData ? { formData } : {}),
        },
      });
      if (paymentMethod === 'pix') setPix(result);
      setMessage(statusText[result.status] || 'Pagamento enviado. Acompanhe a confirmação pela sua conta.');
      if (result.status === 'approved') onPaidRef.current?.();
    } catch (error) {
      if (error.status === 422) {
        attemptKeys.current[paymentMethod] = null;
      }
      setMessage(error.message || 'Não foi possível iniciar o pagamento. Tente novamente.');
      throw error;
    } finally {
      setBusy(false);
    }
  }, [attemptKey, order.orderId]);

  const handleCardReady = useCallback(() => {
    cardBrickReadyRef.current = true;
    setCardBrickReady(true);
    setCardLoadError('');
    setMessage('');
  }, []);

  const handleCardError = useCallback((error) => {
    console.error('[aether] Mercado Pago CardPayment Brick error:', error);
    if (!cardBrickReadyRef.current) setCardLoadError('Nao foi possivel carregar o formulario do cartao. Tente novamente.');
    setMessage('Nao foi possivel carregar os campos do cartao. Tente novamente.');
  }, []);

  const submitCard = useCallback(async (formData) => {
    if (!formData?.payer?.identification?.type || !formData?.payer?.identification?.number) {
      setMessage('Confira o CPF ou CNPJ informado no formulario do cartao.');
      return;
    }
    await submit('card', {
      token: formData.token,
      payment_method_id: formData.payment_method_id,
      installments: formData.installments,
      ...(formData.issuer_id ? { issuer_id: formData.issuer_id } : {}),
      payer: { identification: formData.payer.identification },
    });
  }, [submit]);

  useEffect(() => {
    if (method !== 'card' || !sdkReady || cardBrickReady || cardLoadError) return undefined;
    const timeout = window.setTimeout(() => {
      console.error('[aether] Mercado Pago CardPayment Brick did not become ready within 20 seconds.');
      setCardLoadError('O formulario seguro esta demorando para carregar. Confira sua conexao e tente novamente.');
    }, 20_000);
    return () => window.clearTimeout(timeout);
  }, [cardAttempt, cardBrickReady, cardLoadError, method, sdkReady]);

  async function generatePix() {
    try { await submit('pix'); } catch { /* The message is shown in the checkout. */ }
  }

  async function copyPixCode() {
    try {
      await navigator.clipboard.writeText(pix.qrCode);
      setMessage('Código Pix copiado. Abra o aplicativo do seu banco para pagar.');
    } catch {
      setMessage('Não foi possível copiar automaticamente. Selecione e copie o código Pix.');
    }
  }

  return <section className="checkout-payment" aria-live="polite">
    <p>Pedido <strong>#{order.orderId.slice(0, 8).toUpperCase()}</strong> · total <strong>{order.totalLabel}</strong></p>
    <div className="payment-tabs" role="tablist" aria-label="Forma de pagamento">
      <button type="button" role="tab" aria-selected={method === 'pix'} className={method === 'pix' ? 'active' : ''} onClick={() => { setMethod('pix'); cardBrickReadyRef.current = false; setCardBrickReady(false); }}>Pix</button>
      <button type="button" role="tab" aria-selected={method === 'card'} className={method === 'card' ? 'active' : ''} onClick={() => { setMethod('card'); cardBrickReadyRef.current = false; setCardBrickReady(false); setCardLoadError(''); }}>Cartão</button>
    </div>
    {method === 'pix' && <div className="pix-payment">
      {!pix ? <><p>Gere seu QR Code ou código Pix. A reserva do pedido dura 30 minutos.</p><button type="button" className="add-button" disabled={busy} onClick={generatePix}>{busy ? 'Gerando Pix…' : 'Gerar Pix'}</button></> : <>
        {pix.qrCodeBase64 && <img className="pix-qr" src={`data:image/png;base64,${pix.qrCodeBase64}`} alt="QR Code Pix do pedido"/>}
        {pix.qrCode && <><label htmlFor="pix-copy-code">Pix copia e cola</label><textarea id="pix-copy-code" readOnly value={pix.qrCode} rows={4}/><button type="button" className="secondary" onClick={copyPixCode}>Copiar código Pix</button></>}
        {pix.ticketUrl && <a href={pix.ticketUrl} target="_blank" rel="noreferrer">Abrir instruções do Pix</a>}
        {pix.expirationDate && <small>Expira em {new Date(pix.expirationDate).toLocaleString('pt-BR')}</small>}
      </>}
    </div>}
    {method === 'card' && <div className="card-payment">
      <p>Os dados do cartão são inseridos em campos seguros do Mercado Pago e não ficam armazenados na Aether.</p>
      {sdkReady ? <>
        {cardLoadError ? <div className="payment-feedback" role="alert"><p>{cardLoadError}</p><button type="button" className="secondary" onClick={() => { cardBrickReadyRef.current = false; setCardBrickReady(false); setCardLoadError(''); setCardAttempt((attempt) => attempt + 1); }}>Tentar carregar novamente</button></div> : <>
          {!cardBrickReady && <p className="payment-feedback" role="status">Carregando os campos seguros do cartao...</p>}
          <CardPayment
            key={cardAttempt}
            initialization={cardInitialization}
            locale="pt-BR"
            customization={cardCustomization}
            onSubmit={submitCard}
            onReady={handleCardReady}
            onError={handleCardError}
          />
        </>}
      </> : <p className="payment-feedback">Carregando formulario seguro...</p>}
    </div>}
    {message && <p className="payment-feedback" role="status">{message}</p>}
  </section>;
}
