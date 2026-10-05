import React, { useEffect, useState } from 'react';
import { CardPayment, initMercadoPago } from '@mercadopago/sdk-react';
import { api } from './api.js';

const statusText = {
  approved: 'Pagamento aprovado. Seu pedido já está confirmado.',
  pending: 'Aguardando a confirmação do pagamento.',
  in_process: 'O Mercado Pago está analisando o pagamento.',
  authorized: 'Pagamento autorizado e em processamento.',
};

export default function CheckoutPayment({ order, publicKey, email, onPaid }) {
  const [sdkReady, setSdkReady] = useState(false);
  const [cardBrickReady, setCardBrickReady] = useState(false);
  const [method, setMethod] = useState('pix');
  const [pix, setPix] = useState(null);
  const [message, setMessage] = useState('');
  const [busy, setBusy] = useState(false);
  const [attemptKeys, setAttemptKeys] = useState({});

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

  function attemptKey(paymentMethod) {
    if (attemptKeys[paymentMethod]) return attemptKeys[paymentMethod];
    const key = crypto.randomUUID();
    setAttemptKeys((current) => ({ ...current, [paymentMethod]: key }));
    return key;
  }

  async function submit(paymentMethod, formData) {
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
      if (result.status === 'approved') onPaid?.();
    } catch (error) {
      if (error.status === 422) {
        setAttemptKeys((current) => ({ ...current, [paymentMethod]: null }));
      }
      setMessage(error.message || 'Não foi possível iniciar o pagamento. Tente novamente.');
      throw error;
    } finally {
      setBusy(false);
    }
  }

  async function generatePix() {
    try { await submit('pix'); } catch { /* The message is shown in the checkout. */ }
  }

  async function submitCard(formData) {
    if (!formData?.payer?.identification?.type || !formData?.payer?.identification?.number) {
      setMessage('Confira o CPF ou CNPJ informado no formul\u00e1rio do cart\u00e3o.');
      return;
    }
    await submit('card', {
      token: formData.token,
      payment_method_id: formData.payment_method_id,
      installments: formData.installments,
      ...(formData.issuer_id ? { issuer_id: formData.issuer_id } : {}),
      payer: { identification: formData.payer.identification },
    });
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
      <button type="button" role="tab" aria-selected={method === 'pix'} className={method === 'pix' ? 'active' : ''} onClick={() => { setMethod('pix'); setCardBrickReady(false); }}>Pix</button>
      <button type="button" role="tab" aria-selected={method === 'card'} className={method === 'card' ? 'active' : ''} onClick={() => { setMethod('card'); setCardBrickReady(false); }}>Cartão</button>
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
        {!cardBrickReady && <p className="payment-feedback" role="status">Carregando os campos seguros do cartao...</p>}
        <CardPayment
        initialization={{ amount: order.totalCents / 100, payer: { email } }}
        locale="pt-BR"
        customization={{ paymentMethods: { maxInstallments: 12 } }}
        onSubmit={submitCard}
        onReady={() => { setCardBrickReady(true); setMessage(''); }}
        onError={(error) => { console.error('[aether] Mercado Pago CardPayment Brick error:', error); setMessage('N\u00e3o foi poss\u00edvel carregar o formul\u00e1rio de cart\u00e3o. Atualize a p\u00e1gina e tente novamente.'); }}
      />
      </>: <p className="payment-feedback">Carregando formulário seguro…</p>}
    </div>}
    {message && <p className="payment-feedback" role="status">{message}</p>}
  </section>;
}
