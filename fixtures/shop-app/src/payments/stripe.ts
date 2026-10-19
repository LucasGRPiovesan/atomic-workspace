import Stripe from 'stripe';
import { repo } from '../db/memory.ts';

let stripe: Stripe | null = null;
if (process.env.STRIPE_SECRET_KEY) {
  stripe = new Stripe(process.env.STRIPE_SECRET_KEY, {
    apiVersion: '2026-09-30.endive',
  });
}

export interface ChargeResult {
  id: string;
  status: 'succeeded' | 'failed';
  provider: 'stripe' | 'fake';
  providerChargeId?: string;
}

export async function chargePayment(
  amount: number,
  currency: string,
  description: string,
  metadata: Record<string, string>
): Promise<ChargeResult> {
  if (stripe) {
    try {
      const paymentIntent = await stripe.paymentIntents.create({
        amount: Math.round(amount * 100),
        currency,
        description,
        metadata,
        confirm: true,
        payment_method: 'pm_card_visa',
        return_url: 'http://localhost:4310/return',
      });
      return {
        id: paymentIntent.id,
        status: paymentIntent.status === 'succeeded' ? 'succeeded' : 'failed',
        provider: 'stripe',
        providerChargeId: paymentIntent.id,
      };
    } catch {
      return {
        id: `ch_${Date.now()}`,
        status: 'failed',
        provider: 'stripe',
      };
    }
  }

  const fakeChargeId = `fake_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`;
  return {
    id: fakeChargeId,
    status: 'succeeded',
    provider: 'fake',
    providerChargeId: fakeChargeId,
  };
}