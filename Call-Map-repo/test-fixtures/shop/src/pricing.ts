import { Cart } from "./types";

export class Pricing {
  /** Subtotal minus the coupon, never below zero. */
  static totalFor(cart: Cart): number {
    return Math.max(0, cart.subtotal - (cart.coupon ?? 0));
  }
}
