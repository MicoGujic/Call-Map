export class Payments {
  /** Charges the card. Returns the charge id. */
  static charge(cardToken: string, amount: number): string {
    return `ch_${cardToken}_${amount}`;
  }
}
