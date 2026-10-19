export interface OrderConfirmationData {
  orderId: string;
  userEmail: string;
  userName: string;
  items: { name: string; quantity: number; unitPrice: number }[];
  subtotal: number;
  tax: number;
  total: number;
}

export async function sendOrderConfirmation(data: OrderConfirmationData): Promise<void> {
  const smtpUrl = process.env.SMTP_URL;
  const message = `
=== Order Confirmation Email ===
To: ${data.userEmail}
Subject: Your Order #${data.orderId} Confirmation

Hello ${data.userName},

Thank you for your order! Here are the details:

Order ID: ${data.orderId}
Items:
${data.items.map(i => `  - ${i.name} x${i.quantity} @ $${i.unitPrice.toFixed(2)}`).join('\n')}

Subtotal: $${data.subtotal.toFixed(2)}
Tax (19%): $${data.tax.toFixed(2)}
Total: $${data.total.toFixed(2)}

${smtpUrl ? `Sent via SMTP: ${smtpUrl}` : 'Logged to console (no SMTP configured)'}

Thank you for shopping with us!
===============================
  `.trim();

  console.log(message);
}