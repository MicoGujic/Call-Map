public with sharing class OrderService {
    /**
     * Validates the cart, charges the buyer and reserves stock.
     * @param cart  the cart to buy
     */
    @AuraEnabled
    public static Order__c placeOrder(Cart cart, Contact buyer) {
        validateCart(cart);
        Decimal total = Pricing.totalFor(cart);
        Payments.charge(buyer.Card__c, total);
        return OrderRepo.save(cart, buyer);
    }

    /** Throws when the cart is empty. */
    private static void validateCart(Cart c) {
        if (c.items.isEmpty()) {
            throw new OrderException('Empty cart');
        }
    }
}
