'use strict';
// Cart logic shared by the browser (served at /cart.js) and the Node.js pipeline tests.
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.SecureCart = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  function find(products, id) { return products.find(function (p) { return p.id === id; }); }

  function addItem(cart, productId, products) {
    if (!find(products, productId)) throw new Error('Unknown product: ' + productId);
    const next = Object.assign({}, cart);
    next[productId] = (next[productId] || 0) + 1;
    return next;
  }

  function removeItem(cart, productId) {
    const next = Object.assign({}, cart);
    if (!next[productId]) return next;
    next[productId] -= 1;
    if (next[productId] <= 0) delete next[productId];
    return next;
  }

  function count(cart) {
    return Object.keys(cart).reduce(function (n, id) { return n + cart[id]; }, 0);
  }

  function totalCents(cart, products) {
    return Object.keys(cart).reduce(function (sum, id) {
      const p = find(products, id);
      return p ? sum + p.priceCents * cart[id] : sum;
    }, 0);
  }

  function formatPrice(cents) { return '$' + (cents / 100).toFixed(2); }

  return { addItem: addItem, removeItem: removeItem, count: count, totalCents: totalCents, formatPrice: formatPrice };
});
