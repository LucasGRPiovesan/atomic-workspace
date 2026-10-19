export interface User {
  id: string;
  email: string;
  name: string;
}

export interface Product {
  id: string;
  name: string;
  description: string;
  price: number;
  stock: number;
}

export interface CartItem {
  productId: string;
  quantity: number;
}

export interface Cart {
  userId: string;
  items: CartItem[];
}

export interface OrderItem {
  productId: string;
  quantity: number;
  unitPrice: number;
}

export interface Payment {
  id: string;
  orderId: string;
  amount: number;
  status: 'pending' | 'succeeded' | 'failed';
  provider: 'stripe' | 'fake';
  providerChargeId?: string;
}

export interface Order {
  id: string;
  userId: string;
  items: OrderItem[];
  total: number;
  tax: number;
  status: 'pending' | 'paid' | 'cancelled';
  createdAt: Date;
  payment?: Payment;
}

export interface DBState {
  users: Map<string, User>;
  products: Map<string, Product>;
  carts: Map<string, Cart>;
  orders: Map<string, Order>;
  payments: Map<string, Payment>;
}

export function generateId(prefix: string): string {
  return `${prefix}_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`;
}

const initialUsers: User[] = [
  { id: 'u1', email: 'alice@example.com', name: 'Alice' },
  { id: 'u2', email: 'bob@example.com', name: 'Bob' },
];

const initialProducts: Product[] = [
  { id: 'p1', name: 'Wireless Headphones', description: 'Noise-cancelling over-ear headphones', price: 199.99, stock: 10 },
  { id: 'p2', name: 'Mechanical Keyboard', description: 'RGB backlit mechanical keyboard', price: 129.99, stock: 15 },
  { id: 'p3', name: '4K Monitor', description: '27-inch 4K IPS monitor', price: 399.99, stock: 5 },
  { id: 'p4', name: 'USB-C Hub', description: '7-in-1 USB-C hub with HDMI', price: 49.99, stock: 30 },
  { id: 'p5', name: 'Webcam 1080p', description: 'Full HD webcam with microphone', price: 79.99, stock: 20 },
  { id: 'p6', name: 'Laptop Stand', description: 'Adjustable aluminum laptop stand', price: 39.99, stock: 25 },
];

export const db: DBState = {
  users: new Map(initialUsers.map(u => [u.id, u])),
  products: new Map(initialProducts.map(p => [p.id, p])),
  carts: new Map(),
  orders: new Map(),
  payments: new Map(),
};

initialUsers.forEach(u => {
  db.carts.set(u.id, { userId: u.id, items: [] });
});

export function resetDB(): void {
  db.users.clear();
  db.products.clear();
  db.carts.clear();
  db.orders.clear();
  db.payments.clear();

  initialUsers.forEach(u => db.users.set(u.id, { ...u }));
  initialProducts.forEach(p => db.products.set(p.id, { ...p }));
  initialUsers.forEach(u => db.carts.set(u.id, { userId: u.id, items: [] }));
}

export const repo = {
  users: {
    findById(id: string): User | undefined {
      return db.users.get(id);
    },
    findAll(): User[] {
      return Array.from(db.users.values());
    },
  },
  products: {
    findById(id: string): Product | undefined {
      return db.products.get(id);
    },
    findAll(): Product[] {
      return Array.from(db.products.values());
    },
    updateStock(id: string, delta: number): Product | undefined {
      const product = db.products.get(id);
      if (!product) return undefined;
      product.stock += delta;
      return product;
    },
    setStock(id: string, stock: number): Product | undefined {
      const product = db.products.get(id);
      if (!product) return undefined;
      product.stock = stock;
      return product;
    },
  },
  carts: {
    findByUserId(userId: string): Cart | undefined {
      return db.carts.get(userId);
    },
    upsert(cart: Cart): Cart {
      db.carts.set(cart.userId, cart);
      return cart;
    },
    clear(userId: string): void {
      const cart = db.carts.get(userId);
      if (cart) cart.items = [];
    },
  },
  orders: {
    findById(id: string): Order | undefined {
      return db.orders.get(id);
    },
    findByUserId(userId: string): Order[] {
      return Array.from(db.orders.values()).filter(o => o.userId === userId);
    },
    create(order: Order): Order {
      db.orders.set(order.id, order);
      return order;
    },
    updateStatus(id: string, status: Order['status']): Order | undefined {
      const order = db.orders.get(id);
      if (!order) return undefined;
      order.status = status;
      return order;
    },
  },
  payments: {
    findByOrderId(orderId: string): Payment | undefined {
      return Array.from(db.payments.values()).find(p => p.orderId === orderId);
    },
    create(payment: Payment): Payment {
      db.payments.set(payment.id, payment);
      return payment;
    },
    updateStatus(id: string, status: Payment['status']): Payment | undefined {
      const payment = db.payments.get(id);
      if (!payment) return undefined;
      payment.status = status;
      return payment;
    },
  },
};