import React, { useEffect, useMemo, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { ArrowRight, Camera, Check, Mail, Menu, Minus, Plus, Search, ShoppingBag, UserRound, X } from 'lucide-react';
import AdminPanel from './AdminPanel.jsx';
import { api } from './api.js';
import './style.css';

const categories = ['Todas', 'Anime', 'Games', 'Quadrinhos', 'Filmes', 'Outros', 'Promoções'];
const money = (cents) => (cents / 100).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
const statusLabel = {
  pending_payment: 'Aguardando pagamento',
  paid: 'Pagamento aprovado',
  paid_after_expiry: 'Pagamento aprovado · confirme a entrega',
  expired: 'Pedido expirado',
  checkout_error: 'Pagamento não iniciado',
};
const paymentStatusLabel = {
  rejected: 'Tentativa recusada. Você pode fazer um novo pedido.',
  cancelled: 'Tentativa cancelada. Você pode fazer um novo pedido.',
  in_mediation: 'Pagamento em contestação; aguarde a análise antes de enviar o pedido.',
  charged_back: 'Pagamento contestado (chargeback). Entre em contato com a loja.',
  refunded: 'Reembolso total confirmado.',
  partially_refunded: 'Reembolso parcial confirmado.',
  unknown: 'Atualização de pagamento recebida; confirme com a loja.',
};
const fulfillmentLabel = {
  not_paid: 'Aguardando pagamento',
  processing: 'Em separação',
  shipped: 'Enviado',
  delivered: 'Entregue',
};
const CheckoutPayment = React.lazy(() => import('./CheckoutPayment.jsx'));

class AppErrorBoundary extends React.Component {
  state = { hasError: false, error: null };

  static getDerivedStateFromError(error) {
    return { hasError: true, error };
  }

  componentDidCatch(error, info) {
    console.error('[aether] Interface render failed:', error, info.componentStack);
  }

  render() {
    if (!this.state.hasError) return this.props.children;

    return <main className="error-page" role="alert">
      <a href="/" className="error-brand">AETHER</a>
      <section>
        <span className="eyebrow">AETHER STUDIO</span>
        <h1>NÃ£o foi possÃ­vel carregar a loja.</h1>
        <p>Recarregue a pÃ¡gina para tentar novamente. Se o problema continuar, volte em alguns minutos.</p>
        {import.meta.env.DEV && <pre>{this.state.error?.message}</pre>}
        <button className="outline-button" onClick={() => window.location.reload()}>Tentar novamente</button>
      </section>
    </main>;
  }
}

function readCart(key) {
  try {
    const cart = JSON.parse(localStorage.getItem(`aether-cart:${key}`) || '[]');
    return Array.isArray(cart) ? cart : [];
  } catch {
    return [];
  }
}

function heroSliceLayout(index, count) {
  if (count <= 1) return { left: '0%', width: '100%', clipPath: 'inset(0)' };
  const step = 100 / count;
  const boundary = (position) => {
    const offset = position % 2 === 1 ? -3.5 : 3.5;
    return { top: step * position + offset, bottom: step * position - offset };
  };
  const start = index === 0 ? { top: 0, bottom: 0 } : boundary(index);
  const end = index === count - 1 ? { top: 100, bottom: 100 } : boundary(index + 1);
  const left = Math.min(start.top, start.bottom);
  const right = Math.max(end.top, end.bottom);
  const width = right - left;
  const point = (value) => `${((value - left) / width) * 100}%`;
  return {
    left: `${left}%`,
    width: `${width}%`,
    clipPath: `polygon(${point(start.top)} 0, ${point(end.top)} 0, ${point(end.bottom)} 100%, ${point(start.bottom)} 100%)`,
  };
}

function heroDividerLayout(position, count) {
  const step = 100 / count;
  const offset = position % 2 === 1 ? -3.5 : 3.5;
  const top = step * position + offset;
  const bottom = step * position - offset;
  const thickness = 0.45;
  const left = Math.min(top, bottom) - thickness / 2;
  const width = Math.abs(bottom - top) + thickness;
  return {
    clipPath: `polygon(${((top - left) / width) * 100}% 0, ${((top + thickness / 2 - left) / width) * 100}% 0, ${((bottom + thickness / 2 - left) / width) * 100}% 100%, ${((bottom - thickness / 2 - left) / width) * 100}% 100%)`,
    left: `${left}%`,
    width: `${width}%`,
  };
}

function RatingStars({ rating, label }) {
  return <span className="rating-stars" role="img" aria-label={label || `${rating} de 5 estrelas`}>
    {[1, 2, 3, 4, 5].map((star) => <span className={star <= Math.round(rating) ? 'filled' : ''} key={star}>★</span>)}
  </span>;
}

function ProductDetail({ productId, user, onBack, onAddToCart, onLogin, notify }) {
  const [detail, setDetail] = useState(null);
  const [loadingDetail, setLoadingDetail] = useState(true);
  const [loadError, setLoadError] = useState('');
  const [rating, setRating] = useState(5);
  const [comment, setComment] = useState('');
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    let active = true;
    setLoadingDetail(true);
    setLoadError('');
    api(`/api/products/${productId}`)
      .then((result) => {
        if (!active) return;
        setDetail(result);
        setRating(result.ownReview?.rating || 5);
        setComment(result.ownReview?.comment || '');
        document.title = `${result.product.name} | Aether Studio`;
      })
      .catch((error) => { if (active) setLoadError(error.message); })
      .finally(() => { if (active) setLoadingDetail(false); });
    return () => { active = false; };
  }, [productId, user?.id]);

  async function submitReview(event) {
    event.preventDefault();
    setSubmitting(true);
    try {
      await api(`/api/products/${productId}/reviews`, { method: 'POST', body: { rating, comment } });
      setDetail(await api(`/api/products/${productId}`));
      notify('Sua avaliação foi salva. Obrigado por compartilhar sua experiência.');
    } catch (error) {
      notify(error.message, 'error');
    } finally {
      setSubmitting(false);
    }
  }

  if (loadingDetail) return <section className="product-detail-state" aria-live="polite">Carregando figure...</section>;
  if (loadError || !detail) return <section className="product-detail-state" role="alert"><p>{loadError || 'Não foi possível encontrar esta figure.'}</p><button className="secondary" onClick={onBack}>Voltar ao catálogo</button></section>;

  const { product } = detail;
  return <section className="product-detail-page">
    <button type="button" className="product-back" onClick={onBack}>← Voltar ao catálogo</button>
    <div className="product-detail-grid">
      <div className="product-detail-image">{product.imageUrl ? <img src={product.imageUrl} alt={product.name}/> : <span className="sphere"/>}{product.stock === 0 && <span className="sold-out">ESGOTADO</span>}</div>
      <div className="product-detail-copy">
        <span className="eyebrow">{product.category} · AETHER STUDIO</span>
        <h1>{product.name}</h1>
        <div className="product-rating-summary"><RatingStars rating={detail.averageRating}/><span>{detail.reviewCount ? `${detail.averageRating.toLocaleString('pt-BR')} · ${detail.reviewCount} ${detail.reviewCount === 1 ? 'avaliação' : 'avaliações'}` : 'Ainda sem avaliações'}</span></div>
        <div className="product-detail-price"><strong>{money(product.priceCents)}</strong>{product.compareAtCents > product.priceCents && <del>{money(product.compareAtCents)}</del>}</div>
        <p className="product-detail-description">{product.description || 'Uma peça selecionada para valorizar sua coleção.'}</p>
        <p className={`product-availability ${product.stock ? '' : 'unavailable'}`}>{product.stock ? `${product.stock} ${product.stock === 1 ? 'unidade disponível' : 'unidades disponíveis'}` : 'Indisponível no momento'}</p>
        <button type="button" className="add-button product-detail-add" disabled={!product.stock} onClick={() => onAddToCart(product)}>{product.stock ? 'Adicionar ao carrinho' : 'Figure esgotada'}</button>
        <p className="product-shipping-note">Frete grátis para todo o Brasil.</p>
      </div>
    </div>
    <section className="product-reviews" aria-labelledby="reviews-heading">
      <div className="product-reviews-heading"><div><span className="eyebrow">EXPERIÊNCIAS REAIS</span><h2 id="reviews-heading">Avaliações</h2></div><span>{detail.reviewCount} {detail.reviewCount === 1 ? 'avaliação' : 'avaliações'}</span></div>
      {user && detail.canReview ? <form className="review-form" onSubmit={submitReview}>
        <h3>{detail.ownReview ? 'Atualize sua avaliação' : 'Conte como foi sua experiência'}</h3>
        <label className="review-rating-label">Sua nota<span className="review-rating-picker">{[1, 2, 3, 4, 5].map((star) => <button type="button" key={star} className={star <= rating ? 'selected' : ''} onClick={() => setRating(star)} aria-label={`${star} ${star === 1 ? 'estrela' : 'estrelas'}`} aria-pressed={star === rating}>★</button>)}</span></label>
        <label className="review-comment-label">Sua avaliação<textarea required minLength="10" maxLength="1200" value={comment} onChange={(event) => setComment(event.target.value)} placeholder="Compartilhe detalhes sobre a figure e sua experiência."/></label>
        <div className="review-submit-row"><small>{comment.length}/1200</small><button className="add-button" disabled={submitting}>{submitting ? 'Salvando...' : detail.ownReview ? 'Atualizar avaliação' : 'Publicar avaliação'}</button></div>
      </form> : user ? <p className="review-eligibility">As avaliações ficam disponíveis após a confirmação de uma compra desta figure.</p> : <p className="review-eligibility">Entre na sua conta para avaliar. As avaliações ficam disponíveis para clientes com compra confirmada.</p>}
      {!user && <button type="button" className="switch-auth review-login" onClick={onLogin}>Entrar na minha conta</button>}
      {detail.reviews.length ? <div className="review-list">{detail.reviews.map((review) => <article className="review-card" key={review.id}><div className="review-card-top"><div><b>{review.authorName}</b><RatingStars rating={review.rating}/></div><time dateTime={review.createdAt}>{new Date(review.createdAt).toLocaleDateString('pt-BR')}</time></div><p>{review.comment}</p></article>)}</div> : <p className="review-empty">Esta figure ainda não recebeu avaliações. Seja a primeira pessoa a compartilhar sua experiência após a compra.</p>}
    </section>
  </section>;
}

function App() {
  const [products, setProducts] = useState([]);
  const [user, setUser] = useState(null);
  const [cart, setCart] = useState(() => readCart('guest'));
  const [filter, setFilter] = useState('Todas');
  const [query, setQuery] = useState('');
  const [modal, setModal] = useState('');
  const [authMode, setAuthMode] = useState('login');
  const [orders, setOrders] = useState([]);
  const [loading, setLoading] = useState(true);
  const [paymentsEnabled, setPaymentsEnabled] = useState(false);
  const [missingPaymentVariables, setMissingPaymentVariables] = useState([]);
  const [mercadoPagoPublicKey, setMercadoPagoPublicKey] = useState('');
  const [checkoutOrder, setCheckoutOrder] = useState(null);
  const [emailEnabled, setEmailEnabled] = useState(false);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState(null);
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [currentPassword, setCurrentPassword] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [resetToken, setResetToken] = useState('');
  const [name, setName] = useState('');
  const [newsletterEmail, setNewsletterEmail] = useState('');
  const [newsletterDone, setNewsletterDone] = useState(false);
  const [address, setAddress] = useState({ street: '', number: '', district: '', city: '', state: '', postalCode: '' });
  const [cepLookup, setCepLookup] = useState('idle');
  const [selectedProductId, setSelectedProductId] = useState(() => {
    const match = window.location.pathname.match(/^\/produto\/([0-9a-f-]{36})\/?$/i);
    return match?.[1] || null;
  });

  const cartKey = user?.id || 'guest';
  const count = cart.reduce((sum, item) => sum + item.quantity, 0);
  const total = cart.reduce((sum, item) => sum + item.priceCents * item.quantity, 0);
  const visible = useMemo(() => products.filter((product) => {
    const selected = filter === 'Todas'
      || (filter === 'Promoções' ? product.compareAtCents && product.compareAtCents > product.priceCents : product.category === filter);
    return selected && `${product.name} ${product.category}`.toLowerCase().includes(query.toLowerCase());
  }), [products, filter, query]);
  const featuredProducts = useMemo(() => products
    .filter((product) => product.featuredPosition && product.imageUrl)
    .sort((a, b) => a.featuredPosition - b.featuredPosition), [products]);

  useEffect(() => {
    const handlePopState = () => {
      const match = window.location.pathname.match(/^\/produto\/([0-9a-f-]{36})\/?$/i);
      setSelectedProductId(match?.[1] || null);
    };
    window.addEventListener('popstate', handlePopState);
    return () => window.removeEventListener('popstate', handlePopState);
  }, []);

  function openProduct(product) {
    window.history.pushState({}, '', `/produto/${product.id}`);
    setSelectedProductId(product.id);
    setModal('');
    window.scrollTo({ top: 0, behavior: 'smooth' });
  }

  function goHome(event) {
    event?.preventDefault();
    if (window.location.pathname !== '/' || window.location.search || window.location.hash) window.history.pushState({}, '', '/');
    setSelectedProductId(null);
    document.title = 'Aether Figures | Colecionáveis';
    window.scrollTo({ top: 0, behavior: 'smooth' });
  }

  function notify(message, kind = 'success', action = null) {
    setNotice({ message, kind, action });
    window.clearTimeout(notify.timer);
    if (!action) notify.timer = window.setTimeout(() => setNotice(null), 5500);
  }

  function dismissNotice() {
    window.clearTimeout(notify.timer);
    setNotice(null);
  }

  async function confirmNoticeAction() {
    const action = notice?.action;
    if (!action) return;
    dismissNotice();
    await action.onConfirm();
  }

  async function refreshProducts() {
    const next = await api('/api/products');
    setProducts(next);
  }

  useEffect(() => {
    let alive = true;
    Promise.all([api('/api/products'), api('/api/auth/me'), api('/api/config')])
      .then(([catalog, session, config]) => {
        if (!alive) return;
        setProducts(catalog);
        setUser(session.user);
        setPaymentsEnabled(config.paymentsEnabled);
        setMissingPaymentVariables(config.missingPaymentVariables || []);
        setMercadoPagoPublicKey(config.mercadoPagoPublicKey || '');
        setEmailEnabled(config.emailEnabled);
        setLoading(false);
      })
      .catch((error) => {
        if (!alive) return;
        setLoading(false);
        notify(`Não foi possível conectar à loja. ${error.message}`, 'error');
      });
    return () => { alive = false; };
  }, []);

  useEffect(() => {
    const token = new URLSearchParams(window.location.hash.slice(1)).get('reset_token');
    if (token) {
      setResetToken(token);
      setModal('reset');
    }
  }, []);

  useEffect(() => {
    if (loading || window.location.hash !== '#conta') return;
    setModal(user ? 'account' : 'login');
    setAuthMode('login');
    window.history.replaceState({}, '', `${window.location.pathname}${window.location.search}`);
  }, [loading, user?.id]);

  useEffect(() => {
    setCart(readCart(cartKey));
  }, [cartKey]);

  useEffect(() => {
    const cep = address.postalCode.replace(/\D/g, '');
    if (cep.length !== 8) {
      setCepLookup('idle');
      return undefined;
    }

    const controller = new AbortController();
    setCepLookup('loading');
    fetch(`https://viacep.com.br/ws/${cep}/json/`, { signal: controller.signal })
      .then((response) => {
        if (!response.ok) throw new Error('Falha na consulta do CEP.');
        return response.json();
      })
      .then((result) => {
        if (result.erro) {
          setCepLookup('not-found');
          return;
        }
        setAddress((current) => ({
          ...current,
          street: result.logradouro || current.street,
          district: result.bairro || current.district,
          city: result.localidade || current.city,
          state: result.uf || current.state,
        }));
        setCepLookup('success');
      })
      .catch((error) => {
        if (error.name !== 'AbortError') setCepLookup('error');
      });

    return () => controller.abort();
  }, [address.postalCode]);

  function saveCart(next) {
    setCart(next);
    localStorage.setItem(`aether-cart:${cartKey}`, JSON.stringify(next));
  }

  function addToCart(product) {
    if (product.stock < 1) return notify('Esta figure está sem estoque no momento.', 'error');
    const current = cart.find((item) => item.id === product.id);
    if (current && current.quantity >= product.stock) return notify('Você adicionou todas as unidades disponíveis.', 'error');
    saveCart(current
      ? cart.map((item) => item.id === product.id ? { ...item, quantity: item.quantity + 1 } : item)
      : [...cart, { ...product, quantity: 1 }]);
    notify(`${product.name} adicionada à sacola.`);
  }

  function changeQuantity(productId, delta) {
    const product = products.find((item) => item.id === productId);
    saveCart(cart.map((item) => item.id === productId
      ? { ...item, quantity: Math.max(0, Math.min(item.quantity + delta, product?.stock ?? 10)) }
      : item).filter((item) => item.quantity > 0));
  }

  async function openAccount() {
    setModal('account');
    try {
      setOrders(await api('/api/orders'));
    } catch (error) {
      notify(error.message, 'error');
    }
  }

  useEffect(() => {
    if (loading) return;
    const status = new URLSearchParams(window.location.search).get('pagamento');
    if (!status) return;
    window.history.replaceState({}, '', window.location.pathname);
    const messages = {
      sucesso: 'Pagamento recebido. O pedido será atualizado após a confirmação segura da transação.',
      pendente: 'Pagamento pendente. Acompanhe a atualização em Meus pedidos.',
      falhou: 'O pagamento não foi concluído. Você pode iniciar uma nova tentativa pela sacola.',
    };
    notify(messages[status] || 'Retorno do pagamento recebido. Confira o status em Meus pedidos.');
    if (user) {
      setModal('account');
      api('/api/orders').then(setOrders).catch((error) => notify(error.message, 'error'));
    }
  }, [loading, user?.id]);

  async function submitAuth(event) {
    event.preventDefault();
    setBusy(true);
    try {
      const payload = authMode === 'register' ? { name, email, password } : { email, password };
      const result = await api(`/api/auth/${authMode}`, { method: 'POST', body: payload });
      setUser(result.user);
      setCart(readCart(result.user.id));
      setPassword('');
      setModal('account');
      setOrders(await api('/api/orders'));
      notify(authMode === 'register' ? 'Conta criada com sucesso.' : 'Acesso realizado.');
    } catch (error) {
      notify(error.message, 'error');
    } finally {
      setBusy(false);
    }
  }

  async function logout() {
    try {
      await api('/api/auth/logout', { method: 'POST' });
      setUser(null);
      setOrders([]);
      setCart(readCart('guest'));
      setModal('');
      notify('Você saiu da sua conta.');
    } catch (error) {
      notify(error.message, 'error');
    }
  }

  async function changePassword(event) {
    event.preventDefault();
    setBusy(true);
    try {
      await api('/api/auth/password', { method: 'PUT', body: { currentPassword, newPassword } });
      setCurrentPassword('');
      setNewPassword('');
      notify('Senha alterada. As outras sessões foram encerradas.');
    } catch (error) {
      notify(error.message, 'error');
    } finally {
      setBusy(false);
    }
  }

  async function requestPasswordReset(event) {
    event.preventDefault();
    setBusy(true);
    try {
      const result = await api('/api/auth/password/forgot', { method: 'POST', body: { email } });
      notify(result.message);
      setModal('login');
    } catch (error) {
      notify(error.message, 'error');
    } finally {
      setBusy(false);
    }
  }

  async function resetPassword(event) {
    event.preventDefault();
    setBusy(true);
    try {
      const result = await api('/api/auth/password/reset', {
        method: 'POST',
        body: { token: resetToken, password: newPassword },
      });
      setNewPassword('');
      setResetToken('');
      window.history.replaceState({}, '', window.location.pathname);
      setModal('login');
      notify(result.message);
    } catch (error) {
      notify(error.message, 'error');
    } finally {
      setBusy(false);
    }
  }

  async function checkout(event) {
    event.preventDefault();
    if (!user) {
      setAuthMode('login');
      setModal('login');
      return notify('Entre na sua conta para finalizar a compra.', 'error');
    }
    setBusy(true);
    try {
      const result = await api('/api/orders', {
        method: 'POST',
        body: {
          items: cart.map((item) => ({ productId: item.id, quantity: item.quantity })),
          shippingAddress: address,
        },
      });
      setCheckoutOrder({ ...result, totalLabel: money(result.totalCents) });
      setBusy(false);
    } catch (error) {
      notify(error.message, 'error');
      setBusy(false);
    }
  }

  async function subscribe(event) {
    event.preventDefault();
    try {
      await api('/api/newsletter', { method: 'POST', body: { email: newsletterEmail } });
      setNewsletterDone(true);
      setNewsletterEmail('');
    } catch (error) {
      notify(error.message, 'error');
    }
  }

  const openLogin = () => { setAuthMode('login'); setModal('login'); };
  const useCheckout = () => {
    if (!user) {
      setAuthMode('login');
      setModal('login');
      return notify('Entre na sua conta para finalizar a compra.', 'error');
    }
    setCheckoutOrder(null);
    setModal('checkout');
  };

  return <>
    <div className="announcement">Frete grátis em todas as figures · Parcele em até 12x</div>
    <header>
      <a href="/" onClick={goHome} className="header-brand" aria-label="Aether Studio — página inicial">AETHER</a>
      <div className="header-actions">
        <label className="search"><Search size={16}/><input id="catalog-search" name="q" type="search" value={query} onChange={(event) => { setQuery(event.target.value); document.querySelector('#catalogo')?.scrollIntoView({ behavior: 'smooth' }); }} placeholder="Buscar figure" aria-label="Buscar figure"/></label>
        <button className="account-button" onClick={() => user ? openAccount() : openLogin()}><UserRound size={17}/><span>{user ? 'Minha conta' : 'Entrar'}</span></button>
        <button className="cart-button" onClick={() => setModal('cart')}><ShoppingBag size={17}/> Carrinho ({count})</button>
      </div>
    </header>

    {notice&&<div className={`notice ${notice.kind}`} role={notice.kind==='error'?'alert':'status'} aria-live={notice.kind==='error'?'assertive':'polite'}><span className="notice-message">{notice.message}</span>{notice.action&&<div className="notice-actions"><button type="button" className="notice-cancel" onClick={dismissNotice}>Cancelar</button><button type="button" className="notice-confirm" onClick={confirmNoticeAction}>{notice.action.label}</button></div>}<button type="button" className="notice-close" onClick={dismissNotice} aria-label="Fechar aviso"><X size={15}/></button></div>}

    {modal==='admin' ? <AdminPanel onClose={()=>setModal('')} onChanged={refreshProducts} notify={notify}/> : <main id="top">
      {selectedProductId ? <ProductDetail productId={selectedProductId} user={user} onBack={goHome} onAddToCart={addToCart} onLogin={openLogin} notify={notify}/> : <>
      <section className={`hero ${featuredProducts.length ? 'hero-with-featured' : ''}`}>
        {featuredProducts.length > 0 && <div className="hero-featured-background" aria-hidden="true">
          {featuredProducts.map((product, index) => <div className="hero-slice" key={product.id} style={heroSliceLayout(index, featuredProducts.length)}><img src={product.imageUrl} alt=""/></div>)}
          {featuredProducts.slice(0, -1).map((product, index) => <span className="hero-divider" key={`divider-${product.id}`} style={heroDividerLayout(index + 1, featuredProducts.length)}/>)}
        </div>}
        <div className="hero-inner"><div className="hero-logo" aria-label="Aether Studio"><span>Aether</span><i/><small>STUDIO</small></div><p>Action figures colecionáveis com<br className="desktop-break"/> acabamento de galeria, para quem coleciona<br className="desktop-break"/> pelos detalhes.</p><a className="outline-button" href="#catalogo">Ver figures</a></div>
      </section>

      <section className="catalog" id="catalogo"><div className="catalog-heading"><h1>Catálogo de Figures</h1><p>Todos com frete grátis para o Brasil</p></div>
        <div className="category-list">{categories.map((category)=><button key={category} className={filter===category?'active':''} onClick={()=>setFilter(category)}>{category}</button>)}</div>
        {loading?<div className="catalog-state">Conectando ao catálogo...</div>:<div className="products">{visible.map((product,index)=><article className="product" key={product.id}>
          <button type="button" className={`product-photo product-open art-${index%6}`} onClick={()=>openProduct(product)} aria-label={`Ver detalhes de ${product.name}`}>{product.imageUrl?<img className="figure-image" loading="lazy" src={product.imageUrl} alt={product.name}/>:<span className="sphere"/>}{product.compareAtCents>product.priceCents&&<span className="discount">{Math.round((1-product.priceCents/product.compareAtCents)*100)}% OFF</span>}{product.stock===0&&<span className="sold-out">ESGOTADO</span>}</button>
          <h2>{product.name}</h2><p className="product-subtitle">Figure colecionável · {product.category}</p><div className="prices"><span>{money(product.priceCents)}</span>{product.compareAtCents>product.priceCents&&<del>{money(product.compareAtCents)}</del>}</div>
          <button className="add-button" disabled={!product.stock} onClick={()=>addToCart(product)}>{product.stock?'Adicionar ao carrinho':'Avise-me quando voltar'}</button>
        </article>)}</div>}
        {!loading&&visible.length===0&&<p className="no-products">{products.length===0?'Nossa seleção está sendo preparada. Novas figures chegam em breve.':'Nenhuma figure encontrada nessa categoria.'}</p>}
      </section>

      <section className="about"><div className="about-inner"><h2>Para quem leva a coleção a sério</h2><p>A Aether Studio reúne action figures e estátuas colecionáveis de anime, games, filmes e quadrinhos. Cada figure é escolhida pelo acabamento, pela pintura e pela fidelidade ao personagem, e chega em embalagem reforçada para proteger a sua coleção.</p><div className="perks"><div><b>Frete grátis</b><span>Em todos os figures, para todo o Brasil.</span></div><div><b>Faça sua encomenda</b><span>Não achou o personagem? Encomende e a gente procura para você.</span></div></div></div></section>

      <section className="newsletter"><h2>Receba os lançamentos<br/> primeiro</h2><p>{newsletterDone?'Cadastro realizado. Você receberá novidades da Aether.':'Cadastre seu e-mail e receba os próximos lançamentos em primeira mão.'}</p><form onSubmit={subscribe}><input id="newsletter-email" name="email" autoComplete="email" aria-label="Seu melhor e-mail" required type="email" placeholder="Seu melhor e-mail" value={newsletterEmail} onChange={(event)=>setNewsletterEmail(event.target.value)}/><button type="submit">Cadastrar</button></form></section>
      </>}
    </main>}

    {modal!=='admin'&&<footer><a href="/" onClick={goHome} className="footer-brand">AETHER</a><p>© 2026 Aether Studio.</p><a href="https://instagram.com/aether.studio3d" target="_blank" rel="noreferrer"><Camera/> @aether.studio3d</a><a href="mailto:aetherstudio.figures@gmail.com"><Mail/> aetherstudio.figures@gmail.com</a></footer>}

    {modal&&modal!=='admin'&&<div className="overlay" onClick={()=>setModal('')}>
      <section className={`dialog ${modal==='cart'||modal==='account'?'cart-dialog':''} ${modal==='checkout'?'checkout-dialog':''}`} onClick={(event)=>event.stopPropagation()} aria-modal="true" role="dialog">
        <button className="close" onClick={()=>setModal('')} aria-label="Fechar"><X/></button>
        {modal==='login'&&emailEnabled&&<button className="switch-auth forgot-link" onClick={()=>setModal('forgot')}>Esqueci minha senha</button>}
        {modal==='forgot'&&<><div className="eyebrow">RECUPERAÇÃO DE CONTA</div><h2>Redefina sua senha<span>.</span></h2><p>Informe o e-mail da conta. Se ele estiver cadastrado, enviaremos um link temporário.</p><form className="login-form" onSubmit={requestPasswordReset}><label>E-mail<input type="email" required autoComplete="email" value={email} onChange={(event)=>setEmail(event.target.value)} placeholder="voce@email.com"/></label><button className="add-button" disabled={busy}>{busy?'Enviando...':'Enviar link de recuperação'}</button></form><button className="switch-auth" onClick={()=>setModal('login')}>Voltar para entrar</button></>}
        {modal==='reset'&&<><div className="eyebrow">RECUPERAÇÃO DE CONTA</div><h2>Crie uma nova senha<span>.</span></h2><p>Use pelo menos 10 caracteres. Este link é de uso único e expira em 30 minutos.</p><form className="login-form" onSubmit={resetPassword}><label>Nova senha<input type="password" required minLength="10" autoComplete="new-password" value={newPassword} onChange={(event)=>setNewPassword(event.target.value)} placeholder="Pelo menos 10 caracteres"/></label><button className="add-button" disabled={busy||!resetToken}>{busy?'Salvando...':'Salvar nova senha'}</button></form></>}
        {modal==='cart'&&<><div className="eyebrow">SUA SELEÇÃO</div><h2>Carrinho ({count})</h2>
          {cart.length===0?<p className="empty">Seu carrinho está vazio. Explore o catálogo e encontre sua próxima figure.</p>:<>
            <div className="cart-items">{cart.map((item)=><div className="cart-item" key={item.id}><div className="cart-thumb">{item.imageUrl?<img src={item.imageUrl} alt=""/>:<span className="sphere"/>}</div><div className="cart-info"><b>{item.name}</b><span>{money(item.priceCents)}</span><div className="quantity"><button onClick={()=>changeQuantity(item.id,-1)} aria-label="Diminuir"><Minus size={13}/></button>{item.quantity}<button onClick={()=>changeQuantity(item.id,1)} aria-label="Aumentar"><Plus size={13}/></button></div></div></div>)}</div>
            <div className="cart-total"><span>Total · frete grátis</span><b>{money(total)}</b></div><button className="add-button" onClick={useCheckout}>Continuar para pagamento <ArrowRight size={16}/></button>{!paymentsEnabled&&<small className="checkout-note">A finalização online estará disponível em breve.</small>}
          </>}
        </>}

        {(modal==='login'||modal==='register')&&<><div className="eyebrow">CONTA AETHER</div><h2>{authMode==='register'?'Crie sua conta':'Entre na sua conta'}<span>.</span></h2><p>Acompanhe seus pedidos e tenha seu histórico de compras em um só lugar.</p>
          <form className="login-form" onSubmit={submitAuth}>{authMode==='register'&&<label>Nome completo<input required minLength="2" maxLength="100" autoComplete="name" value={name} onChange={(event)=>setName(event.target.value)} placeholder="Como podemos chamar você?"/></label>}<label>E-mail<input type="email" required autoComplete="email" value={email} onChange={(event)=>setEmail(event.target.value)} placeholder="voce@email.com"/></label><label>Senha<input type="password" required minLength={authMode==='register'?10:1} autoComplete={authMode==='register'?'new-password':'current-password'} value={password} onChange={(event)=>setPassword(event.target.value)} placeholder={authMode==='register'?'Pelo menos 10 caracteres':'Sua senha'}/></label><button className="add-button" disabled={busy}>{busy?'Aguarde...':authMode==='register'?'Criar conta':'Entrar'}</button></form>
          <button className="switch-auth" onClick={()=>setAuthMode(authMode==='login'?'register':'login')}>{authMode==='login'?'Ainda não tem conta? Criar conta':'Já tem uma conta? Entrar'}</button><small className="checkout-note">Sua sessão é protegida e os pedidos ficam vinculados a esta conta.</small>
        </>}

        {modal==='account'&&<><div className="eyebrow">ÁREA DO CLIENTE</div><h2>Olá, {user?.name?.split(' ')[0]}<span>.</span></h2><p>{user?.email}</p>{user?.isAdmin&&<button className="add-button admin-open" onClick={()=>setModal('admin')}>Abrir painel de catálogo <ArrowRight size={16}/></button>}<div className="account-section"><div className="account-section-heading"><h3>Meus pedidos</h3><span>{orders.length}</span></div>{orders.length===0?<p className="empty-orders">Seus pedidos e atualizações de pagamento aparecerão aqui.</p>:orders.map((order)=><article className="order-card" key={order.id}><div className="order-title"><b>Pedido #{order.id.slice(0,8).toUpperCase()}</b><span className={`order-status ${order.status}`}>{statusLabel[order.status]||order.status}</span></div><small>{new Date(order.createdAt).toLocaleDateString('pt-BR')} · {money(order.totalCents)}</small><small className="payment-status-detail">Entrega: {fulfillmentLabel[order.fulfillmentStatus] || fulfillmentLabel.not_paid}{order.trackingCode && <> · Rastreio {order.trackingCode}</>}</small>{paymentStatusLabel[order.paymentStatus]&&<small className="payment-status-detail">{paymentStatusLabel[order.paymentStatus]}{order.refundedCents>0?` · Reembolsado: ${money(order.refundedCents)}`:''}</small>}<div className="order-lines">{order.items.map((item,index)=><span key={`${order.id}-${index}`}>{item.quantity}× {item.productName}</span>)}</div><small className="order-address">Entrega: {order.shippingAddress.street}, {order.shippingAddress.number} · {order.shippingAddress.city}/{order.shippingAddress.state} · CEP {order.shippingAddress.postalCode}</small></article>)}<form className="password-form" onSubmit={changePassword}><h3>Segurança da conta</h3><label>Senha atual<input type="password" required value={currentPassword} onChange={event=>setCurrentPassword(event.target.value)} autoComplete="current-password"/></label><label>Nova senha<input type="password" required minLength="10" value={newPassword} onChange={event=>setNewPassword(event.target.value)} autoComplete="new-password"/></label><button className="secondary" disabled={busy}>{busy?'Salvando...':'Alterar senha'}</button></form><button className="text-button logout" onClick={logout}>Sair da conta</button></div></>}

        {modal==='checkout'&&<>
          <div className="eyebrow">ENTREGA E PAGAMENTO</div><h2>Finalize seu pedido<span>.</span></h2>
          {!checkoutOrder ? <>
            <p>Confira o endereço de entrega. Você poderá pagar com cartão ou Pix nesta página.</p>
            <form className="login-form checkout-form" onSubmit={checkout}>
              <label>CEP<input required inputMode="numeric" autoComplete="postal-code" maxLength="9" pattern="[0-9]{5}-?[0-9]{3}" value={address.postalCode} onChange={(event)=>{const digits=event.target.value.replace(/\D/g,'').slice(0,8);setAddress((current)=>({...current,postalCode:digits.length>5?`${digits.slice(0,5)}-${digits.slice(5)}`:digits}));}} placeholder="00000-000" aria-describedby="cep-status"/>{cepLookup==='idle'?<small id="cep-status" className="cep-status">Ao completar o CEP, consultamos o ViaCEP para preencher os dados disponíveis.</small>:<small id="cep-status" className={`cep-status ${cepLookup}`} role="status" aria-live="polite">{cepLookup==='loading'?'Consultando endereço pelo CEP...':cepLookup==='success'?'Endereço localizado. Confira os dados e informe o número.':cepLookup==='not-found'?'CEP não encontrado. Confira o número ou preencha o endereço manualmente.':'Não foi possível consultar o CEP agora. Você pode preencher o endereço manualmente.'}</small>}</label>
              <label>Rua<input required autoComplete="address-line1" value={address.street} onChange={(event)=>setAddress((current)=>({...current,street:event.target.value}))} placeholder="Nome da rua"/></label>
              <div className="checkout-row"><label>Número<input required autoComplete="address-line2" value={address.number} onChange={(event)=>setAddress((current)=>({...current,number:event.target.value}))}/></label><label>Bairro<input autoComplete="address-level3" value={address.district} onChange={(event)=>setAddress((current)=>({...current,district:event.target.value}))}/></label></div>
              <label>Cidade<input required autoComplete="address-level2" value={address.city} onChange={(event)=>setAddress((current)=>({...current,city:event.target.value}))}/></label>
              <label>Estado (UF)<input required minLength="2" maxLength="2" autoComplete="address-level1" value={address.state} onChange={(event)=>setAddress((current)=>({...current,state:event.target.value.toUpperCase()}))} placeholder="SP"/></label>
              <div className="cart-total"><span>Total · frete grátis</span><b>{money(total)}</b></div>
              <button className="add-button" disabled={busy||!paymentsEnabled}>{busy?'Preparando pedido...':'Continuar para pagamento'}</button>
              {!paymentsEnabled&&<small className="checkout-note">Pagamentos desativados. No Coolify, configure: {missingPaymentVariables.length ? missingPaymentVariables.join(', ') : 'credenciais do Mercado Pago'}. Depois faça o redeploy.</small>}
            </form>
          </> : <>
            <React.Suspense fallback={<p className="payment-feedback" role="status">Carregando pagamento seguro…</p>}><CheckoutPayment order={checkoutOrder} publicKey={mercadoPagoPublicKey} email={user?.email} onPaid={()=>{setCart([]);api('/api/orders').then(setOrders).catch((error)=>notify(error.message,'error'));}} /></React.Suspense>
            <button type="button" className="text-button" onClick={()=>setCheckoutOrder(null)}>Voltar ao endereço</button>
          </>}
        </>}      </section>
    </div>}
  </>;
}

createRoot(document.getElementById('root')).render(<AppErrorBoundary><App/></AppErrorBoundary>);
