import React, { useMemo, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { Search, UserRound, ShoppingBag, Menu, X, Plus, Minus, ArrowRight, Camera, Mail } from 'lucide-react';
import './style.css';

const products = [
 {id:1,name:'Kaede, a Espadachim',category:'Anime',price:1400,art:'kaede'},
 {id:2,name:'Ryu Kuroba',category:'Anime',price:1300,oldPrice:1500,art:'ryu'},
 {id:3,name:'Sentinela Vermelha',category:'Games',price:1500,art:'sentinela'},
 {id:4,name:'Lady Vex',category:'Games',price:1200,oldPrice:1400,art:'vex'},
 {id:5,name:'Guardião do Crepúsculo',category:'Quadrinhos',price:1350,oldPrice:1550,art:'guardiao'},
 {id:6,name:'Mestre das Sombras',category:'Anime',price:1100,art:'sombras'},
];
const categories=['Todas','Anime','Games','Quadrinhos','Promoções'];
const money=n=>n.toLocaleString('pt-BR',{style:'currency',currency:'BRL'});
function App(){
 const [cart,setCart]=useState(()=>JSON.parse(localStorage.getItem('aether-cart')||'[]'));
 const [user,setUser]=useState(()=>JSON.parse(localStorage.getItem('aether-user')||'null'));
 const [filter,setFilter]=useState('Todas');const [query,setQuery]=useState('');const [modal,setModal]=useState('');const [email,setEmail]=useState('');const [subscribed,setSubscribed]=useState(false);
 const count=cart.reduce((n,p)=>n+p.qty,0);const total=cart.reduce((n,p)=>n+p.price*p.qty,0);
 const visible=useMemo(()=>products.filter(p=>(filter==='Todas'||(filter==='Promoções'?!!p.oldPrice:p.category===filter))&&(p.name+p.category).toLowerCase().includes(query.toLowerCase())),[filter,query]);
 const saveCart=c=>{setCart(c);localStorage.setItem('aether-cart',JSON.stringify(c))};
 const add=p=>{const old=cart.find(i=>i.id===p.id);saveCart(old?cart.map(i=>i.id===p.id?{...i,qty:i.qty+1}:i):[...cart,{...p,qty:1}])};
 const change=(id,n)=>saveCart(cart.map(p=>p.id===id?{...p,qty:p.qty+n}:p).filter(p=>p.qty>0));
 const login=e=>{e.preventDefault();const next={email,name:email.split('@')[0]};setUser(next);localStorage.setItem('aether-user',JSON.stringify(next));setModal('')};
 return <>
  <div className="announcement">Frete grátis em todas as figures</div>
  <header><a href="#top" className="header-brand">AETHER</a><div className="header-actions"><label className="search"><Search size={16}/><input value={query} onChange={e=>{setQuery(e.target.value);document.querySelector('#catalogo')?.scrollIntoView({behavior:'smooth'})}} placeholder="Buscar figure"/></label><button className="account-button" onClick={()=>setModal(user?'account':'login')}><UserRound size={17}/><span>{user?'Minha conta':'Entrar'}</span></button><button className="cart-button" onClick={()=>setModal('cart')}><ShoppingBag size={17}/> Carrinho ({count})</button></div></header>
  <main id="top">
   <section className="hero"><div className="hero-inner"><div className="hero-logo" aria-label="Aether Studio"><span>Aether</span><i/><small>STUDIO</small></div><p>Action figures colecionáveis com<br className="desktop-break"/> acabamento de galeria, para quem coleciona<br className="desktop-break"/> pelos detalhes.</p><a className="outline-button" href="#catalogo">Ver figures</a></div></section>
   <section className="catalog" id="catalogo"><div className="catalog-heading"><h1>Catálogo de Figures</h1><p>Todos com frete grátis para o Brasil</p></div><div className="category-list">{categories.map(c=><button key={c} className={filter===c?'active':''} onClick={()=>setFilter(c)}>{c}</button>)}</div><div className="products">{visible.map(p=><article className="product" key={p.id}><div className={'product-photo '+p.art}><span className="sphere"/>{p.oldPrice&&<span className="discount">{Math.round((1-p.price/p.oldPrice)*100)}% OFF</span>}</div><h2>{p.name}</h2><p className="product-subtitle">Figure colecionável · {p.category}</p><div className="prices"><span>{money(p.price)}</span>{p.oldPrice&&<del>{money(p.oldPrice)}</del>}</div><button className="add-button" onClick={()=>add(p)}>Adicionar ao carrinho</button></article>)}</div>{visible.length===0&&<p className="no-products">Nenhuma figure encontrada nessa categoria.</p>}</section>
   <section className="about"><div className="about-inner"><h2>Para quem leva a coleção a sério</h2><p>A Aether Studio reúne action figures e estátuas colecionáveis de anime, games, filmes e quadrinhos. Cada figure é escolhida pelo acabamento, pela pintura e pela fidelidade ao personagem, e chega em embalagem reforçada para proteger a sua coleção.</p><div className="perks"><div><b>Frete grátis</b><span>Em todos os figures, para todo o Brasil.</span></div><div><b>Faça sua encomenda</b><span>Não achou o personagem? Encomende e a gente procura para você.</span></div></div></div></section>
   <section className="newsletter"><h2>Receba os lançamentos<br/> primeiro</h2><p>{subscribed?'Inscrição recebida. Obrigado por fazer parte da Aether!':'Cadastre seu e-mail e ganhe 10% na primeira compra.'}</p><form onSubmit={e=>{e.preventDefault();setSubscribed(true)}}><input aria-label="Seu melhor e-mail" required type="email" placeholder="Seu melhor e-mail" value={email} onChange={e=>setEmail(e.target.value)}/><button type="submit">Cadastrar</button></form></section>
  </main>
  <footer><a href="#top" className="footer-brand">AETHER</a><p>© 2026 Aether Studio.</p><a href="https://instagram.com/aether.studio3d"><Camera/> @aether.studio3d</a><a href="mailto:aetherstudio.figures@gmail.com"><Mail/> aetherstudio.figures@gmail.com</a></footer>
  {modal&&<div className="overlay" onClick={()=>setModal('')}><section className={'dialog '+(modal==='cart'?'cart-dialog':'')} onClick={e=>e.stopPropagation()}><button className="close" onClick={()=>setModal('')} aria-label="Fechar"><X/></button>{modal==='cart'?<><h2>Carrinho ({count})</h2>{cart.length===0?<p className="empty">Seu carrinho está vazio. Explore o catálogo e encontre sua próxima figure.</p>:<><div className="cart-items">{cart.map(p=><div className="cart-item" key={p.id}><div className={'cart-thumb '+p.art}><span className="sphere"/></div><div className="cart-info"><b>{p.name}</b><span>{money(p.price)}</span><div className="quantity"><button onClick={()=>change(p.id,-1)}><Minus size={13}/></button>{p.qty}<button onClick={()=>change(p.id,1)}><Plus size={13}/></button></div></div></div>)}</div><div className="cart-total"><span>Total</span><b>{money(total)}</b></div><button className="add-button" onClick={()=>setModal('checkout')}>Continuar para pagamento</button><small className="checkout-note">Frete grátis · Pagamento será configurado na próxima etapa.</small></>}</>:modal==='login'?<><h2>Entre na sua conta</h2><p>Acompanhe seus pedidos e sua coleção.</p><form className="login-form" onSubmit={login}><label>E-mail<input type="email" required placeholder="voce@email.com" value={email} onChange={e=>setEmail(e.target.value)}/></label><label>Senha<input type="password" required minLength="4" placeholder="Sua senha"/></label><button className="add-button">Entrar</button></form><small className="checkout-note">Sessão demonstrativa salva neste dispositivo.</small></>:modal==='account'?<><h2>Olá, {user?.name}</h2><p>Sessão ativa para {user?.email}</p><button className="add-button" onClick={()=>{localStorage.removeItem('aether-user');setUser(null);setModal('')}}>Sair da conta</button></>:<><h2>Seu pedido</h2><p>O checkout será ativado quando conectarmos o meio de pagamento.</p><b>{money(total)}</b><button className="add-button" onClick={()=>setModal('')}>Voltar ao catálogo</button></>}</section></div>}
 </>;
}
createRoot(document.getElementById('root')).render(<App/>);
