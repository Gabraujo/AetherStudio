import React, { useEffect, useMemo, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { ArrowRight, Camera, Check, Mail, Menu, Minus, Plus, Search, ShoppingBag, UserRound, X } from 'lucide-react';
import AdminPanel from './AdminPanel.jsx';
import { api } from './api.js';
import './style.css';

const categories = ['Todas', 'Anime', 'Games', 'Quadrinhos', 'Promoções'];
const money = (cents) => (cents / 100).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
const statusLabel = {
  pending_payment: 'Aguardando pagamento',
  paid: 'Pagamento aprovado',
  paid_after_expiry: 'Pagamento aprovado · confirme a entrega',
  expired: 'Pedido expirado',
  checkout_error: 'Pagamento não iniciado',
};

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
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState(null);
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [currentPassword, setCurrentPassword] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [name, setName] = useState('');
  const [newsletterEmail, setNewsletterEmail] = useState('');
  const [newsletterDone, setNewsletterDone] = useState(false);
  const [address, setAddress] = useState({ street: '', number: '', district: '', city: '', state: '', postalCode: '' });

  const cartKey = user?.id || 'guest';
  const count = cart.reduce((sum, item) => sum + item.quantity, 0);
  const total = cart.reduce((sum, item) => sum + item.priceCents * item.quantity, 0);
  const visible = useMemo(() => products.filter((product) => {
    const selected = filter === 'Todas'
      || (filter === 'Promoções' ? product.compareAtCents && product.compareAtCents > product.priceCents : product.category === filter);
    return selected && `${product.name} ${product.category}`.toLowerCase().includes(query.toLowerCase());
  }), [products, filter, query]);

  function notify(message, kind = 'success') {
    setNotice({ message, kind });
    window.clearTimeout(notify.timer);
    notify.timer = window.setTimeout(() => setNotice(null), 5500);
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
    setCart(readCart(cartKey));
  }, [cartKey]);

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
      sucesso: 'Retorno do Mercado Pago recebido. O pedido só aparece como pago após a confirmação segura do pagamento.',
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
      window.location.assign(result.checkoutUrl);
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
    setModal('checkout');
  };

  return <>
    <div className="announcement">Frete grátis em todas as figures · Parcele em até 12x</div>
    <header>
      <a href="#top" className="header-brand">AETHER</a>
      <div className="header-actions">
        <label className="search"><Search size={16}/><input value={query} onChange={(event) => { setQuery(event.target.value); document.querySelector('#catalogo')?.scrollIntoView({ behavior: 'smooth' }); }} placeholder="Buscar figure" aria-label="Buscar figure"/></label>
        <button className="account-button" onClick={() => user ? openAccount() : openLogin()}><UserRound size={17}/><span>{user ? 'Minha conta' : 'Entrar'}</span></button>
        <button className="cart-button" onClick={() => setModal('cart')}><ShoppingBag size={17}/> Carrinho ({count})</button>
      </div>
    </header>

    {notice&&<div className={`notice ${notice.kind}`} role="status"><span>{notice.message}</span><button onClick={()=>setNotice(null)} aria-label="Fechar aviso"><X size={15}/></button></div>}

    {modal==='admin' ? <AdminPanel onClose={()=>setModal('')} onChanged={refreshProducts} notify={notify}/> : <main id="top">
      <section className="hero"><div className="hero-inner"><div className="hero-logo" aria-label="Aether Studio"><span>Aether</span><i/><small>STUDIO</small></div><p>Action figures colecionáveis com<br className="desktop-break"/> acabamento de galeria, para quem coleciona<br className="desktop-break"/> pelos detalhes.</p><a className="outline-button" href="#catalogo">Ver figures</a></div></section>

      <section className="catalog" id="catalogo"><div className="catalog-heading"><h1>Catálogo de Figures</h1><p>Todos com frete grátis para o Brasil</p></div>
        <div className="category-list">{categories.map((category)=><button key={category} className={filter===category?'active':''} onClick={()=>setFilter(category)}>{category}</button>)}</div>
        {loading?<div className="catalog-state">Conectando ao catálogo...</div>:<div className="products">{visible.map((product,index)=><article className="product" key={product.id}>
          <div className={`product-photo art-${index%6}`}>{product.imageUrl?<img className="figure-image" loading="lazy" src={product.imageUrl} alt={product.name}/>:<span className="sphere"/>}{product.compareAtCents>product.priceCents&&<span className="discount">{Math.round((1-product.priceCents/product.compareAtCents)*100)}% OFF</span>}{product.stock===0&&<span className="sold-out">ESGOTADO</span>}</div>
          <h2>{product.name}</h2><p className="product-subtitle">Figure colecionável · {product.category}</p><div className="prices"><span>{money(product.priceCents)}</span>{product.compareAtCents>product.priceCents&&<del>{money(product.compareAtCents)}</del>}</div>
          <button className="add-button" disabled={!product.stock} onClick={()=>addToCart(product)}>{product.stock?'Adicionar ao carrinho':'Avise-me quando voltar'}</button>
        </article>)}</div>}
        {!loading&&visible.length===0&&<p className="no-products">{products.length===0?'Nossa seleção está sendo preparada. Novas figures chegam em breve.':'Nenhuma figure encontrada nessa categoria.'}</p>}
      </section>

      <section className="about"><div className="about-inner"><h2>Para quem leva a coleção a sério</h2><p>A Aether Studio reúne action figures e estátuas colecionáveis de anime, games, filmes e quadrinhos. Cada figure é escolhida pelo acabamento, pela pintura e pela fidelidade ao personagem, e chega em embalagem reforçada para proteger a sua coleção.</p><div className="perks"><div><b>Frete grátis</b><span>Em todos os figures, para todo o Brasil.</span></div><div><b>Faça sua encomenda</b><span>Não achou o personagem? Encomende e a gente procura para você.</span></div></div></div></section>

      <section className="newsletter"><h2>Receba os lançamentos<br/> primeiro</h2><p>{newsletterDone?'Cadastro realizado. Você receberá novidades da Aether.':'Cadastre seu e-mail e receba os próximos lançamentos em primeira mão.'}</p><form onSubmit={subscribe}><input aria-label="Seu melhor e-mail" required type="email" placeholder="Seu melhor e-mail" value={newsletterEmail} onChange={(event)=>setNewsletterEmail(event.target.value)}/><button type="submit">Cadastrar</button></form></section>
    </main>}

    {modal!=='admin'&&<footer><a href="#top" className="footer-brand">AETHER</a><p>© 2026 Aether Studio.</p><a href="https://instagram.com/aether.studio3d" target="_blank" rel="noreferrer"><Camera/> @aether.studio3d</a><a href="mailto:aetherstudio.figures@gmail.com"><Mail/> aetherstudio.figures@gmail.com</a></footer>}

    {modal&&modal!=='admin'&&<div className="overlay" onClick={()=>setModal('')}>
      <section className={`dialog ${modal==='cart'||modal==='account'?'cart-dialog':''}`} onClick={(event)=>event.stopPropagation()} aria-modal="true" role="dialog">
        <button className="close" onClick={()=>setModal('')} aria-label="Fechar"><X/></button>
        {modal==='cart'&&<><div className="eyebrow">SUA SELEÇÃO</div><h2>Carrinho ({count})</h2>
          {cart.length===0?<p className="empty">Seu carrinho está vazio. Explore o catálogo e encontre sua próxima figure.</p>:<>
            <div className="cart-items">{cart.map((item)=><div className="cart-item" key={item.id}><div className="cart-thumb">{item.imageUrl?<img src={item.imageUrl} alt=""/>:<span className="sphere"/>}</div><div className="cart-info"><b>{item.name}</b><span>{money(item.priceCents)}</span><div className="quantity"><button onClick={()=>changeQuantity(item.id,-1)} aria-label="Diminuir"><Minus size={13}/></button>{item.quantity}<button onClick={()=>changeQuantity(item.id,1)} aria-label="Aumentar"><Plus size={13}/></button></div></div></div>)}</div>
            <div className="cart-total"><span>Total · frete grátis</span><b>{money(total)}</b></div><button className="add-button" onClick={useCheckout}>Continuar para pagamento <ArrowRight size={16}/></button>{!paymentsEnabled&&<small className="checkout-note">O checkout será liberado após configurar as credenciais do Mercado Pago.</small>}
          </>}
        </>}

        {(modal==='login'||modal==='register')&&<><div className="eyebrow">CONTA AETHER</div><h2>{authMode==='register'?'Crie sua conta':'Entre na sua conta'}<span>.</span></h2><p>Acompanhe seus pedidos e tenha seu histórico de compras em um só lugar.</p>
          <form className="login-form" onSubmit={submitAuth}>{authMode==='register'&&<label>Nome completo<input required minLength="2" maxLength="100" autoComplete="name" value={name} onChange={(event)=>setName(event.target.value)} placeholder="Como podemos chamar você?"/></label>}<label>E-mail<input type="email" required autoComplete="email" value={email} onChange={(event)=>setEmail(event.target.value)} placeholder="voce@email.com"/></label><label>Senha<input type="password" required minLength={authMode==='register'?10:1} autoComplete={authMode==='register'?'new-password':'current-password'} value={password} onChange={(event)=>setPassword(event.target.value)} placeholder={authMode==='register'?'Pelo menos 10 caracteres':'Sua senha'}/></label><button className="add-button" disabled={busy}>{busy?'Aguarde...':authMode==='register'?'Criar conta':'Entrar'}</button></form>
          <button className="switch-auth" onClick={()=>setAuthMode(authMode==='login'?'register':'login')}>{authMode==='login'?'Ainda não tem conta? Criar conta':'Já tem uma conta? Entrar'}</button><small className="checkout-note">Sua sessão é protegida e os pedidos ficam vinculados a esta conta.</small>
        </>}

        {modal==='account'&&<><div className="eyebrow">ÁREA DO CLIENTE</div><h2>Olá, {user?.name?.split(' ')[0]}<span>.</span></h2><p>{user?.email}</p>{user?.isAdmin&&<button className="add-button admin-open" onClick={()=>setModal('admin')}>Abrir painel de catálogo <ArrowRight size={16}/></button>}<div className="account-section"><div className="account-section-heading"><h3>Meus pedidos</h3><span>{orders.length}</span></div>{orders.length===0?<p className="empty-orders">Seus pedidos e atualizações de pagamento aparecerão aqui.</p>:orders.map((order)=><article className="order-card" key={order.id}><div className="order-title"><b>Pedido #{order.id.slice(0,8).toUpperCase()}</b><span className={`order-status ${order.status}`}>{statusLabel[order.status]||order.status}</span></div><small>{new Date(order.createdAt).toLocaleDateString('pt-BR')} · {money(order.totalCents)}</small><div className="order-lines">{order.items.map((item,index)=><span key={`${order.id}-${index}`}>{item.quantity}× {item.productName}</span>)}</div><small className="order-address">Entrega: {order.shippingAddress.street}, {order.shippingAddress.number} · {order.shippingAddress.city}/{order.shippingAddress.state} · CEP {order.shippingAddress.postalCode}</small></article>)}<form className="password-form" onSubmit={changePassword}><h3>Segurança da conta</h3><label>Senha atual<input type="password" required value={currentPassword} onChange={event=>setCurrentPassword(event.target.value)} autoComplete="current-password"/></label><label>Nova senha<input type="password" required minLength="10" value={newPassword} onChange={event=>setNewPassword(event.target.value)} autoComplete="new-password"/></label><button className="secondary" disabled={busy}>{busy?'Salvando...':'Alterar senha'}</button></form><button className="text-button logout" onClick={logout}>Sair da conta</button></div></>}

        {modal==='checkout'&&<><div className="eyebrow">ENTREGA</div><h2>Endereço de envio<span>.</span></h2><p>O frete é grátis. Revise o endereço antes de continuar ao Mercado Pago.</p><form className="login-form checkout-form" onSubmit={checkout}><label>CEP<input required inputMode="numeric" pattern="[0-9.\-]{8,10}" value={address.postalCode} onChange={(event)=>setAddress({...address,postalCode:event.target.value})} placeholder="00000-000"/></label><label>Rua<input required value={address.street} onChange={(event)=>setAddress({...address,street:event.target.value})} placeholder="Nome da rua"/></label><div className="checkout-row"><label>Número<input required value={address.number} onChange={(event)=>setAddress({...address,number:event.target.value})}/></label><label>Bairro<input value={address.district} onChange={(event)=>setAddress({...address,district:event.target.value})}/></label></div><label>Cidade<input required value={address.city} onChange={(event)=>setAddress({...address,city:event.target.value})}/></label><label>Estado (UF)<input required minLength="2" maxLength="2" value={address.state} onChange={(event)=>setAddress({...address,state:event.target.value.toUpperCase()})} placeholder="SP"/></label><div className="cart-total"><span>Total · frete grátis</span><b>{money(total)}</b></div><button className="add-button" disabled={busy||!paymentsEnabled}>{busy?'Preparando pagamento...':'Ir para pagamento seguro'}</button>{!paymentsEnabled&&<small className="checkout-note">Mercado Pago ainda precisa ser configurado no servidor.</small>}</form></>}
      </section>
    </div>}
  </>;
}

createRoot(document.getElementById('root')).render(<AppErrorBoundary><App/></AppErrorBoundary>);
