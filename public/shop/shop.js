(function () {
  'use strict';
  var KEY = 'secureops-shop-cart';
  var $ = function (id) { return document.getElementById(id); };
  var cart = {}, products = [];

  function load() { try { return JSON.parse(localStorage.getItem(KEY) || '{}'); } catch (e) { return {}; } }
  function save() { try { localStorage.setItem(KEY, JSON.stringify(cart)); } catch (e) { /* storage unavailable */ } }
  function clean() {
    var out = {};
    Object.keys(cart).forEach(function (id) {
      if (products.some(function (p) { return p.id === id; }) && Number.isInteger(cart[id]) && cart[id] > 0) out[id] = cart[id];
    });
    cart = out;
  }

  function renderCart() {
    var list = $('cartList');
    list.textContent = '';
    Object.keys(cart).forEach(function (id) {
      var p = products.filter(function (x) { return x.id === id; })[0];
      var li = document.createElement('li');
      var name = document.createElement('span');
      name.textContent = p.name + ' · ' + SecureCart.formatPrice(p.priceCents * cart[id]);
      var q = document.createElement('span'); q.className = 'qty';
      var minus = document.createElement('button'); minus.type = 'button'; minus.textContent = '−'; minus.setAttribute('aria-label', 'Remove one ' + p.name);
      var n = document.createElement('b'); n.textContent = cart[id];
      var plus = document.createElement('button'); plus.type = 'button'; plus.textContent = '+'; plus.setAttribute('aria-label', 'Add one ' + p.name);
      minus.onclick = function () { cart = SecureCart.removeItem(cart, id); update(); };
      plus.onclick = function () { cart = SecureCart.addItem(cart, id, products); update(); };
      q.appendChild(minus); q.appendChild(n); q.appendChild(plus);
      li.appendChild(name); li.appendChild(q); list.appendChild(li);
    });
    var total = SecureCart.formatPrice(SecureCart.totalCents(cart, products));
    $('cartCount').textContent = SecureCart.count(cart);
    $('cartTotal').textContent = total;
    $('cartTotal2').textContent = total;
    $('cartEmpty').hidden = SecureCart.count(cart) > 0;
  }
  function update() { save(); renderCart(); }

  function renderProducts() {
    var grid = $('grid');
    grid.textContent = '';
    products.forEach(function (p) {
      var card = document.createElement('article'); card.className = 'card';
      var img = document.createElement('img'); img.src = '/img/' + encodeURIComponent(p.id) + '.svg'; img.alt = p.name; img.width = 400; img.height = 300;
      var info = document.createElement('div'); info.className = 'info';
      var h = document.createElement('h3'); h.textContent = p.name;
      var price = document.createElement('div'); price.className = 'price'; price.textContent = SecureCart.formatPrice(p.priceCents);
      var btn = document.createElement('button'); btn.type = 'button'; btn.className = 'btn'; btn.textContent = 'Add to Cart';
      btn.onclick = function () { cart = SecureCart.addItem(cart, p.id, products); update(); };
      info.appendChild(h); info.appendChild(price); info.appendChild(btn);
      card.appendChild(img); card.appendChild(info); grid.appendChild(card);
    });
  }

  fetch('/api/products', { cache: 'no-store' })
    .then(function (r) { if (!r.ok) throw new Error('HTTP ' + r.status); return r.json(); })
    .then(function (d) {
      products = d.products;
      document.documentElement.style.setProperty('--accent', d.accent);
      document.title = d.storeName;
      $('storeName').textContent = d.storeName;
      $('version').textContent = 'v' + d.version;
      $('footVer').textContent = d.version;
      if (d.banner) { $('banner').textContent = d.banner; $('banner').hidden = false; }
      cart = load(); clean();
      renderProducts(); update();
      $('clearBtn').onclick = function () { cart = {}; update(); };
    })
    .catch(function (e) {
      var g = $('grid'); g.textContent = '';
      var div = document.createElement('div'); div.className = 'err';
      div.textContent = 'The shop could not load its products (' + e.message + ').';
      g.appendChild(div);
    });
})();
