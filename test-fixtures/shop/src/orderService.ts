import { Buyer, Cart, Order } from "./types";
import { Pricing } from "./pricing";
import { Payments } from "./payments";
import { saveOrder } from "./orderRepo";

export class OrderService {
  /**
   * Validates the cart, charges the buyer and saves the order.
   * Throws if the cart is empty.
   */
  placeOrder(cart: Cart, buyer: Buyer): Order {
    this.validateCart(cart);
    const total = Pricing.totalFor(cart);
    Payments.charge(buyer.card, total);
    return saveOrder(cart, buyer, total);
  }

  /** Throws when the cart has no items. */
  private validateCart(c: Cart): void {
    if (!c.items.length) throw new Error("empty cart");
  }
}
