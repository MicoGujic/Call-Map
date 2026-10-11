import { OrderService } from "./orderService";
import { Buyer, Cart } from "./types";

/** Called when the buyer clicks Pay. */
export function submit(req: { cart: Cart; buyer: Buyer }) {
  const svc = new OrderService();
  return svc.placeOrder(req.cart, req.buyer);
}

/** Nightly retry of failed orders. */
export function retryFailed(failed: { cart: Cart; buyer: Buyer }[]) {
  const svc = new OrderService();
  for (const f of failed) svc.placeOrder(f.cart, f.buyer);
}
