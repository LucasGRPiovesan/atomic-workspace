export const TAX_RATE = 0.19;

export function calculateSubtotal(items: { unitPrice: number; quantity: number }[]): number {
  return items.reduce((sum, item) => sum + item.unitPrice * item.quantity, 0);
}

export function calculateTax(subtotal: number): number {
  return Math.round(subtotal * TAX_RATE * 100) / 100;
}

export function calculateTotal(subtotal: number): number {
  return subtotal + calculateTax(subtotal);
}