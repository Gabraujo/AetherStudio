import { useEffect, useState } from 'react';
import { Archive, ArrowLeft, ImagePlus, PackageCheck, Pencil, Plus, RotateCcw, Save, ShoppingBag, Star, X } from 'lucide-react';
import { api } from './api.js';

const emptyForm = {
  name: '', category: 'Anime', description: '', price: '', compareAt: '', stock: '1', imageUrl: '', active: true,
};
const formatPrice = (cents) => (cents / 100).toFixed(2);
const priceCents = (value) => Math.round(Number(value) * 100);
const money = (cents) => (cents / 100).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
const orderStatuses = {
  pending_payment: 'Aguardando pagamento',
  paid: 'Pagamento aprovado',
  paid_after_expiry: 'Pago após a reserva expirar',
  expired: 'Reserva expirada',
  checkout_error: 'Pagamento não iniciado',
};
const paymentStatuses = {
  pending: 'Pagamento pendente',
  approved: 'Pagamento aprovado',
  authorized: 'Pagamento autorizado',
  in_process: 'Pagamento em processamento',
  in_mediation: 'Contestação em análise',
  rejected: 'Tentativa recusada',
  cancelled: 'Tentativa cancelada',
  refunded: 'Reembolso total',
  partially_refunded: 'Reembolso parcial',
  charged_back: 'Chargeback',
  unknown: 'Status desconhecido; conferir no Mercado Pago',
};
const fulfillmentStatuses = {
  not_paid: 'Aguardando pagamento',
  processing: 'Em separação',
  shipped: 'Enviado',
  delivered: 'Entregue',
};

export default function AdminPanel({ onClose, onChanged, notify }) {
  const [products, setProducts] = useState([]);
  const [featuredIds, setFeaturedIds] = useState([]);
  const [orders, setOrders] = useState([]);
  const [form, setForm] = useState(emptyForm);
  const [editingId, setEditingId] = useState(null);
  const [section, setSection] = useState('products');
  const [busy, setBusy] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [loading, setLoading] = useState(true);
  const [ordersLoading, setOrdersLoading] = useState(true);
  const [featuredSaving, setFeaturedSaving] = useState(false);
  const [trackingCodes, setTrackingCodes] = useState({});
  const [updatingOrderId, setUpdatingOrderId] = useState(null);

  async function refresh() {
    setLoading(true);
    try {
      const catalog = await api('/api/admin/products');
      setProducts(catalog);
      setFeaturedIds(catalog.filter((product) => product.featuredPosition)
        .sort((a, b) => a.featuredPosition - b.featuredPosition)
        .map((product) => product.id));
    } catch (error) {
      notify(error.message, 'error');
    } finally {
      setLoading(false);
    }
  }

  function toggleFeatured(product) {
    if (featuredIds.includes(product.id)) {
      setFeaturedIds(featuredIds.filter((id) => id !== product.id));
      return;
    }
    if (!product.active || !product.imageUrl) {
      notify('Publique a figure e adicione uma imagem antes de destacá-la.', 'error');
      return;
    }
    if (featuredIds.length >= 4) {
      notify('Escolha no máximo quatro figures para a página inicial.', 'error');
      return;
    }
    setFeaturedIds([...featuredIds, product.id]);
  }

  async function saveFeatured() {
    setFeaturedSaving(true);
    try {
      await api('/api/admin/featured', { method: 'PUT', body: { productIds: featuredIds } });
      notify('Destaques da página inicial salvos.');
      await refresh();
      onChanged();
    } catch (error) {
      notify(error.message, 'error');
    } finally {
      setFeaturedSaving(false);
    }
  }

  function resetFeatured() {
    setFeaturedIds(products.filter((product) => product.featuredPosition)
      .sort((a, b) => a.featuredPosition - b.featuredPosition)
      .map((product) => product.id));
  }

  async function refreshOrders() {
    setOrdersLoading(true);
    try {
      setOrders(await api('/api/admin/orders'));
    } catch (error) {
      notify(error.message, 'error');
    } finally {
      setOrdersLoading(false);
    }
  }

  async function updateFulfillment(order, status) {
    setUpdatingOrderId(order.id);
    try {
      await api(`/api/admin/orders/${order.id}/fulfillment`, {
        method: 'PUT',
        body: { status, trackingCode: trackingCodes[order.id]?.trim() || '' },
      });
      notify(status === 'shipped' ? 'Pedido enviado. O cliente receberá um e-mail com o rastreio.' : 'Pedido marcado como entregue. O cliente receberá uma atualização por e-mail.');
      await refreshOrders();
    } catch (error) {
      notify(error.message, 'error');
    } finally {
      setUpdatingOrderId(null);
    }
  }

  useEffect(() => {
    refresh();
    refreshOrders();
  }, []);

  const savedFeaturedIds = products.filter((product) => product.featuredPosition)
    .sort((a, b) => a.featuredPosition - b.featuredPosition)
    .map((product) => product.id);
  const featuredChanged = featuredIds.length !== savedFeaturedIds.length
    || featuredIds.some((id, index) => id !== savedFeaturedIds[index]);

  function edit(product) {
    setEditingId(product.id);
    setForm({
      name: product.name,
      category: product.category,
      description: product.description || '',
      price: formatPrice(product.priceCents),
      compareAt: product.compareAtCents ? formatPrice(product.compareAtCents) : '',
      stock: String(product.stock),
      imageUrl: product.imageUrl || '',
      active: product.active,
    });
    setSection('products');
    window.scrollTo({ top: 0, behavior: 'smooth' });
  }

  async function save(event) {
    event.preventDefault();
    setBusy(true);
    const body = {
      name: form.name,
      category: form.category,
      description: form.description,
      priceCents: priceCents(form.price),
      compareAtCents: form.compareAt ? priceCents(form.compareAt) : null,
      stock: Number(form.stock),
      imageUrl: form.imageUrl.trim() || null,
      active: form.active,
    };
    try {
      await api(editingId ? `/api/admin/products/${editingId}` : '/api/admin/products', {
        method: editingId ? 'PUT' : 'POST',
        body,
      });
      notify(editingId ? 'Figure atualizada.' : 'Figure adicionada ao catálogo.');
      setEditingId(null);
      setForm(emptyForm);
      await refresh();
      onChanged();
    } catch (error) {
      notify(error.message, 'error');
    } finally {
      setBusy(false);
    }
  }

  async function uploadImage(event) {
    const file = event.target.files?.[0];
    if (!file) return;
    const payload = new FormData();
    payload.append('image', file);
    setUploading(true);
    try {
      const result = await api('/api/admin/uploads', { method: 'POST', body: payload });
      setForm((current) => ({ ...current, imageUrl: result.imageUrl }));
      notify('Imagem enviada com segurança.');
    } catch (error) {
      notify(error.message, 'error');
    } finally {
      setUploading(false);
      event.target.value = '';
    }
  }

  function archive(product) {
    notify(`Remover “${product.name}” do catálogo?`, 'confirm', {
      label: 'Remover',
      onConfirm: async () => {
        try {
          await api(`/api/admin/products/${product.id}`, { method: 'DELETE' });
          notify('Figure removida do catálogo. O histórico de pedidos foi preservado.');
          await refresh();
          onChanged();
        } catch (error) {
          notify(error.message, 'error');
        }
      },
    });
  }

  async function restore(product) {
    try {
      await api(`/api/admin/products/${product.id}`, {
        method: 'PUT',
        body: {
          name: product.name,
          category: product.category,
          description: product.description || '',
          priceCents: product.priceCents,
          compareAtCents: product.compareAtCents,
          stock: product.stock,
          imageUrl: product.imageUrl,
          active: true,
        },
      });
      notify('Figure restaurada no catálogo.');
      await refresh();
      onChanged();
    } catch (error) {
      notify(error.message, 'error');
    }
  }

  return <div className="admin-page">
    <div className="admin-topline">
      <button className="text-button" onClick={onClose}><ArrowLeft size={16}/> Voltar à loja</button>
      <span>PAINEL ADMINISTRATIVO</span>
    </div>

    <div className="admin-heading">
      <div>
        <div className="eyebrow">AETHER STUDIO</div>
        <h1>{section === 'products' ? 'Catálogo' : section === 'orders' ? 'Pedidos' : 'Página inicial'}<span>.</span></h1>
        <p>{section === 'products' ? 'Adicione peças, ajuste preços e estoque ou remova itens da vitrine.' : section === 'orders' ? 'Acompanhe pagamentos, clientes e endereços de entrega.' : 'Escolha até quatro figures para compor o destaque visual da loja.'}</p>
      </div>
      {section === 'products' && <button className="add-button admin-new" onClick={() => { setEditingId(null); setForm(emptyForm); document.querySelector('.admin-form')?.scrollIntoView({ behavior: 'smooth' }); }}><Plus size={16}/> Nova figure</button>}
    </div>

    <nav className="admin-nav" aria-label="Seções administrativas">
      <button className={section === 'products' ? 'active' : ''} onClick={() => setSection('products')}><PackageCheck size={15}/> Catálogo</button>
      <button className={section === 'featured' ? 'active' : ''} onClick={() => setSection('featured')}><Star size={15}/> Página inicial <span>{featuredIds.length}/4</span></button>
      <button className={section === 'orders' ? 'active' : ''} onClick={() => setSection('orders')}><ShoppingBag size={15}/> Pedidos <span>{orders.length}</span></button>
    </nav>

    {section === 'products' && <>
      <form className="admin-form" onSubmit={save}>
        <div className="admin-form-title">
          <div><ImagePlus size={18}/><h2>{editingId ? 'Editar figure' : 'Nova figure'}</h2></div>
          {editingId && <button className="icon-button" type="button" onClick={() => { setEditingId(null); setForm(emptyForm); }} aria-label="Cancelar edição"><X/></button>}
        </div>
        <div className="admin-fields">
          <label>Nome da figure<input required minLength="2" maxLength="140" value={form.name} onChange={(event) => setForm({ ...form, name: event.target.value })} placeholder="Ex.: Kaede, a Espadachim"/></label>
          <label>Categoria<select value={form.category} onChange={(event) => setForm({ ...form, category: event.target.value })}>{['Anime', 'Games', 'Quadrinhos', 'Filmes', 'Outros'].map((category) => <option key={category}>{category}</option>)}</select></label>
          <label>Preço (R$)<input required type="number" min="0.01" step="0.01" value={form.price} onChange={(event) => setForm({ ...form, price: event.target.value })} placeholder="0,00"/></label>
          <label>Preço anterior (R$)<input type="number" min="0.01" step="0.01" value={form.compareAt} onChange={(event) => setForm({ ...form, compareAt: event.target.value })} placeholder="Opcional"/></label>
          <label>Estoque<input required type="number" min="0" step="1" value={form.stock} onChange={(event) => setForm({ ...form, stock: event.target.value })}/></label>
          <label className="span-all">Enviar imagem (JPG, PNG ou WebP · até 5 MB)<input type="file" accept="image/jpeg,image/png,image/webp" onChange={uploadImage} disabled={uploading}/>{uploading && <small>Enviando imagem...</small>}</label>
          <label className="span-all">Ou usar URL HTTPS<input type="url" value={form.imageUrl.startsWith('/uploads/') ? '' : form.imageUrl} onChange={(event) => setForm({ ...form, imageUrl: event.target.value })} placeholder="https://..."/></label>
          {form.imageUrl && <div className="admin-image-preview"><img src={form.imageUrl} alt="Prévia da imagem da figure"/></div>}
          <label className="span-all">Descrição<textarea rows="3" maxLength="2000" value={form.description} onChange={(event) => setForm({ ...form, description: event.target.value })} placeholder="Detalhes da peça, escala, fabricante..."/></label>
          <label className="admin-publish"><input type="checkbox" checked={form.active} onChange={(event) => setForm({ ...form, active: event.target.checked })}/> Publicar no catálogo</label>
        </div>
        <button className="add-button admin-save" disabled={busy || uploading}>{busy ? <span>Salvando...</span> : <><Save size={16}/>{editingId ? 'Salvar alterações' : 'Adicionar ao catálogo'}</>}</button>
      </form>

      <div className="admin-list-heading"><h2>Figures cadastradas</h2><span>{products.filter((product) => product.active).length} ativas</span></div>
      {loading ? <p className="admin-empty">Carregando catálogo...</p> : products.length === 0 ? <p className="admin-empty">Nenhuma figure cadastrada.</p> : <div className="admin-list">{products.map((product) => <article className={`admin-product ${product.active ? '' : 'archived'}`} key={product.id}>
        <div className={`admin-thumb ${product.category.toLowerCase()}`}>{product.imageUrl ? <img src={product.imageUrl} alt=""/> : <span className="sphere"/>}</div>
        <div className="admin-product-copy"><small>{product.category} · {product.active ? 'ATIVA' : 'FORA DO CATÁLOGO'}</small><b>{product.name}</b><span>{money(product.priceCents)} · {product.stock} em estoque</span></div>
        <div className="admin-product-actions"><button className="icon-button" onClick={() => edit(product)} aria-label={`Editar ${product.name}`}><Pencil size={16}/></button>{product.active ? <button className="icon-button danger" onClick={() => archive(product)} aria-label={`Remover ${product.name}`}><Archive size={16}/></button> : <button className="icon-button" onClick={() => restore(product)} aria-label={`Restaurar ${product.name}`}><RotateCcw size={16}/></button>}</div>
      </article>)}</div>}
    </>}

    {section === 'featured' && <section className="featured-admin">
      <div className="featured-admin-heading">
        <div><h2>Figures em destaque</h2><p>Selecione de uma a quatro figures publicadas com imagem. A ordem da seleção define a sequência da esquerda para a direita.</p></div>
        <span className="featured-count">{featuredIds.length} / 4 selecionadas</span>
      </div>
      {loading ? <p className="admin-empty">Carregando catálogo...</p> : products.filter((product) => product.active).length === 0 ? <p className="admin-empty">Publique uma figure para poder destacá-la.</p> : <div className="featured-admin-grid">
        {products.filter((product) => product.active).map((product) => {
          const selectedIndex = featuredIds.indexOf(product.id);
          const selected = selectedIndex >= 0;
          const unavailable = !product.imageUrl || (!selected && featuredIds.length >= 4);
          return <label className={`featured-admin-card ${selected ? 'selected' : ''} ${unavailable ? 'unavailable' : ''}`} key={product.id}>
            <input type="checkbox" checked={selected} disabled={!selected && unavailable} onChange={() => toggleFeatured(product)}/>
            <div className="featured-admin-thumb">{product.imageUrl ? <img src={product.imageUrl} alt=""/> : <ImagePlus size={20} />}{selected && <span>{String(selectedIndex + 1).padStart(2, '0')}</span>}</div>
            <b>{product.name}</b>
            <small>{product.imageUrl ? product.category : 'Adicione uma imagem para destacar'}</small>
          </label>;
        })}
      </div>}
      <div className="featured-admin-actions"><button className="add-button" disabled={!featuredChanged || featuredSaving || loading} onClick={saveFeatured}>{featuredSaving ? 'Salvando...' : 'Salvar destaques'}</button><button className="secondary" disabled={!featuredChanged || featuredSaving || loading} onClick={resetFeatured}>Descartar alterações</button></div>
      <p className="featured-admin-hint">Se nenhuma figure estiver selecionada, a página inicial mantém apenas o visual Aether.</p>
    </section>}

    {section === 'orders' && <section className="admin-orders">
      <div className="admin-list-heading"><h2>Pedidos recentes</h2><button className="secondary" onClick={refreshOrders} disabled={ordersLoading}>{ordersLoading ? 'Atualizando...' : 'Atualizar pedidos'}</button></div>
      {ordersLoading && orders.length === 0 ? <p className="admin-empty">Carregando pedidos...</p> : orders.length === 0 ? <p className="admin-empty">Nenhum pedido foi registrado ainda.</p> : orders.map((order) => <article className="admin-order" key={order.id}>
        <div className="admin-order-top"><div><small>#{order.id.slice(0, 8).toUpperCase()} · {new Date(order.createdAt).toLocaleString('pt-BR')}</small><h3>{order.customer.name}</h3><a href={`mailto:${order.customer.email}`}>{order.customer.email}</a></div><div className="admin-order-total"><span className={`order-status ${order.status}`}>{orderStatuses[order.status] || order.status}</span><b>{money(order.totalCents)}</b><small className="payment-status-detail">{paymentStatuses[order.paymentStatus] || paymentStatuses.unknown}{order.refundedCents>0?` · Reembolsado ${money(order.refundedCents)}`:''}</small></div></div>
        <div className="admin-order-items">{order.items.map((item, index) => <span key={`${order.id}-${index}`}>{item.quantity}× {item.productName}<b>{money(item.unitPriceCents * item.quantity)}</b></span>)}</div>
        <div className="admin-order-address"><small>Endereço de entrega</small><span>{order.shippingAddress.street}, {order.shippingAddress.number}{order.shippingAddress.district ? ` · ${order.shippingAddress.district}` : ''} · {order.shippingAddress.city}/{order.shippingAddress.state} · CEP {order.shippingAddress.postalCode}</span></div>
      {order.status === 'paid' && order.paymentStatus === 'approved' && order.fulfillmentStatus !== 'delivered' && <div className="fulfillment-control">
        <span>Entrega: {fulfillmentStatuses[order.fulfillmentStatus] || fulfillmentStatuses.not_paid}</span>
        {order.fulfillmentStatus === 'processing' ? <><input aria-label="Código de rastreio" placeholder="Código de rastreio" value={trackingCodes[order.id] || ''} onChange={(event) => setTrackingCodes({ ...trackingCodes, [order.id]: event.target.value })}/><button className="secondary" disabled={updatingOrderId === order.id} onClick={() => updateFulfillment(order, 'shipped')}>Marcar enviado</button></> : <button className="secondary" disabled={updatingOrderId === order.id} onClick={() => updateFulfillment(order, 'delivered')}>Marcar entregue</button>}
      </div>}
      </article>)}
      {!ordersLoading && orders.length >= 200 && <p className="admin-empty">Exibindo os 200 pedidos mais recentes.</p>}
    </section>}
  </div>;
}
