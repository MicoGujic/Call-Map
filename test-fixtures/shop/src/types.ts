export interface Item { sku: string; qty: number; }
export interface Cart { items: Item[]; subtotal: number; coupon?: number; }
export interface Buyer { id: string; card: string; email: string; }
export interface Order { id: string; total: number; }
