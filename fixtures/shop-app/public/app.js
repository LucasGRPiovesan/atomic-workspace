const API_BASE = '/api';

async function fetchAPI(path, options = {}) {
  const res = await fetch(`${API_BASE}${path}`, {
    headers: { 'Content-Type': 'application/json', 'x-user': 'u1', ...options.headers },
    ...options,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error ?? `HTTP ${res.status}`);
  return data;
}

function showView(viewId) {
  document.querySelectorAll('main > div').forEach(el => el.classList.remove('active'));
  document.getElementById(viewId)?.classList.add('active');
}

function showError(message) {
  const container = document.getElementById('error-container');
  container.innerHTML = `<div class="error">${message}</div>`;
  setTimeout(() => container.innerHTML = '', 5000);
}

function updateCartCount(count) {
  document.getElementById('cart-count').textContent = String(count);
}

async function loadProducts() {
  const container = document.getElementById('home-view');
  container.innerHTML = '<div class="loading">Loading products...</div>';
  try {
    const products = await fetchAPI('/products');
    container.innerHTML = products.map((p) => `
      <article class="product-card" data-id="${p.id}">
        <h3>${p.name}</h3>
        <p>${p.description}</p>
        <div class="price">$${p.price.toFixed(2)}</div>
        <p style="color: ${p.stock > 0 ? '#2a7' : '#e00'}">
          ${p.stock > 0 ? `In stock: ${p.stock}` : 'Out of stock'}
        </p>
        <button ${p.stock === 0 ? 'disabled' : ''} onclick="viewProduct('${p.id}')">
          ${p.stock > 0 ? 'View Details' : 'Out of Stock'}
        </button>
      </article>
    `).join('');
  } catch (err) {
    showError('Failed to load products');
  }
}

async function viewProduct(id) {
  try {
    const product = await fetchAPI(`/products/${id}`);
    const container = document.getElementById('product-detail');
    container.innerHTML = `
      <div class="detail-image">${product.name}</div>
      <h2>${product.name}</h2>
      <p>${product.description}</p>
      <div class="price">$${product.price.toFixed(2)}</div>
      <p style="color: ${product.stock > 0 ? '#2a7' : '#e00'}">
        ${product.stock > 0 ? `In stock: ${product.stock}` : 'Out of stock'}
      </p>
      <div class="detail-actions">
        <button onclick="addToCart('${product.id}')" ${product.stock === 0 ? 'disabled' : ''}>
          Add to cart
        </button>
        <button class="secondary" onclick="showView('home-view')">Back to products</button>
      </div>
    `;
    showView('product-view');
    history.pushState(null, '', `/product/${id}`);
  } catch (err) {
    showError('Failed to load product');
  }
}

async function addToCart(productId) {
  try {
    const cart = await fetchAPI('/cart/items', {
      method: 'POST',
      body: JSON.stringify({ productId, quantity: 1 }),
    });
    updateCartCount(cart.items.reduce((sum, i) => sum + i.quantity, 0));
    showView('home-view');
  } catch (err) {
    showError(err instanceof Error ? err.message : 'Failed to add to cart');
  }
}

async function loadCart() {
  try {
    const cart = await fetchAPI('/cart');
    const itemsContainer = document.getElementById('cart-items');
    const summaryContainer = document.getElementById('cart-summary');
    const checkoutBtn = document.getElementById('checkout-btn');

    if (!cart.items.length) {
      itemsContainer.innerHTML = '<p style="text-align:center; color:#666; padding:2rem;">Your cart is empty</p>';
      summaryContainer.innerHTML = '';
      checkoutBtn.disabled = true;
      updateCartCount(0);
      return;
    }

    const products = await fetchAPI('/products');
    const productMap = new Map(products.map((p) => [p.id, p]));

    itemsContainer.innerHTML = cart.items.map((item) => {
      const product = productMap.get(item.productId);
      return `
        <div class="cart-item">
          <div>
            <strong>${product?.name ?? 'Unknown'}</strong>
            <div style="color:#666;">$${product?.price.toFixed(2) ?? '?'} x ${item.quantity}</div>
          </div>
          <div>
            <div class="price">$${(product?.price * item.quantity ?? 0).toFixed(2)}</div>
            <button onclick="removeFromCart('${item.productId}')">Remove</button>
          </div>
        </div>
      `;
    }).join('');

    const subtotal = cart.items.reduce((sum, item) => {
      const product = productMap.get(item.productId);
      return sum + (product?.price ?? 0) * item.quantity;
    }, 0);
    const tax = Math.round(subtotal * 0.19 * 100) / 100;
    const total = subtotal + tax;

    summaryContainer.innerHTML = `
      <div class="row"><span>Subtotal</span><span>$${subtotal.toFixed(2)}</span></div>
      <div class="row"><span>Tax (19%)</span><span>$${tax.toFixed(2)}</span></div>
      <div class="row total"><span>Total</span><span>$${total.toFixed(2)}</span></div>
    `;
    checkoutBtn.disabled = false;
    updateCartCount(cart.items.reduce((sum, i) => sum + i.quantity, 0));
  } catch (err) {
    showError('Failed to load cart');
  }
}

async function removeFromCart(productId) {
  try {
    await fetchAPI(`/cart/items/${productId}`, { method: 'DELETE' });
    loadCart();
  } catch (err) {
    showError('Failed to remove item');
  }
}

async function checkout() {
  try {
    const order = await fetchAPI('/orders', { method: 'POST' });
    showOrderConfirmation(order);
  } catch (err) {
    showError(err instanceof Error ? err.message : 'Checkout failed');
  }
}

function showOrderConfirmation(order) {
  const container = document.getElementById('order-details');
  container.innerHTML = `
    <div class="row"><span>Order ID</span><span>${order.id}</span></div>
    <div class="row"><span>Status</span><span>${order.status}</span></div>
    <div class="row"><span>Date</span><span>${new Date(order.createdAt).toLocaleString()}</span></div>
    <hr style="margin: 1rem 0;">
    ${order.items.map((item) => `
      <div class="row"><span>${item.name || item.productId} x${item.quantity}</span><span>$${(item.unitPrice * item.quantity).toFixed(2)}</span></div>
    `).join('')}
    <hr style="margin: 1rem 0;">
    <div class="row"><span>Subtotal</span><span>$${(order.total - order.tax).toFixed(2)}</span></div>
    <div class="row"><span>Tax</span><span>$${order.tax.toFixed(2)}</span></div>
    <div class="row total"><span>Total</span><span>$${order.total.toFixed(2)}</span></div>
  `;
  document.getElementById('cancel-order-btn').onclick = () => cancelOrder(order.id);
  document.getElementById('cancel-order-btn').style.display = order.status === 'paid' ? 'inline-block' : 'none';
  showView('order-view');
  history.pushState(null, '', `/order/${order.id}`);
}

async function cancelOrder(orderId) {
  if (!confirm('Are you sure you want to cancel this order?')) return;
  try {
    const order = await fetchAPI(`/orders/${orderId}/cancel`, { method: 'POST' });
    showOrderConfirmation(order);
  } catch (err) {
    showError(err instanceof Error ? err.message : 'Cancellation failed');
  }
}

async function loadOrder(orderId) {
  try {
    const order = await fetchAPI(`/orders/${orderId}`);
    showOrderConfirmation(order);
  } catch (err) {
    showError('Failed to load order');
  }
}

function handleRoute() {
  const hash = location.hash.slice(1) || '/';
  if (hash === '/' || hash === '') {
    showView('home-view');
    loadProducts();
  } else if (hash.startsWith('/product/')) {
    viewProduct(hash.split('/')[2]);
  } else if (hash === '/cart') {
    showView('cart-view');
    loadCart();
  } else if (hash.startsWith('/order/')) {
    loadOrder(hash.split('/')[2]);
  }
}

window.addEventListener('hashchange', handleRoute);
window.addEventListener('load', handleRoute);

window.viewProduct = viewProduct;
window.addToCart = addToCart;
window.removeFromCart = removeFromCart;
window.checkout = checkout;
document.getElementById('back-btn').addEventListener('click', () => { location.hash = '#/'; showView('home-view'); });
document.getElementById('checkout-btn').addEventListener('click', checkout);
