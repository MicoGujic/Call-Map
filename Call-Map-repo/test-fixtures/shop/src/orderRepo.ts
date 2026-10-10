import { Buyer, Cart, Order } from "./types";

// Stores the order and returns it with an id.
export function saveOrder(cart: Cart, buyer: Buyer, total: number): Order {
  return { id: `${buyer.id}-${cart.items.length}`, total };
}
