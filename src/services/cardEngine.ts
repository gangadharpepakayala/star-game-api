import { PhysicalCard, SubmittedCard } from '../models/types';

export class CardEngine {
  /**
   * Generates 4 copies of each submitted card type.
   * Total cards = players.length * 4.
   */
  public static generateDeck(submittedCards: SubmittedCard[]): PhysicalCard[] {
    const deck: PhysicalCard[] = [];

    for (const sub of submittedCards) {
      const typeSlug = sub.cardName.trim().toUpperCase().replace(/[^A-Z0-9]/g, '_');
      for (let copy = 1; copy <= 4; copy++) {
        deck.push({
          id: `${typeSlug}_${sub.playerId.slice(0, 4)}_${copy}_${Math.random().toString(36).slice(2, 6)}`,
          cardTypeId: sub.playerId, // unique identifier for the submitted card type
          cardName: sub.cardName.trim(),
          cardImageUrl: undefined,
          currentOwnerId: '',
          position: 0,
        });
      }
    }

    return deck;
  }

  /**
   * Cryptographically secure Fisher-Yates shuffle.
   */
  public static shuffleDeck(deck: PhysicalCard[]): PhysicalCard[] {
    const shuffled = [...deck];
    const n = shuffled.length;
    
    // Use Web Crypto API or crypto module for secure randomness
    const randomBuffer = new Uint32Array(n);
    crypto.getRandomValues(randomBuffer);

    for (let i = n - 1; i > 0; i--) {
      const j = randomBuffer[i] % (i + 1);
      [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
    }

    return shuffled;
  }

  /**
   * Distributes exactly 4 cards to each player.
   * Total cards must equal playerIds.length * 4.
   */
  public static dealCards(
    shuffledDeck: PhysicalCard[],
    playerIds: string[]
  ): { hands: Map<string, PhysicalCard[]>; allCards: PhysicalCard[] } {
    if (shuffledDeck.length !== playerIds.length * 4) {
      throw new Error(`Deck size ${shuffledDeck.length} does not match required ${playerIds.length * 4}`);
    }

    const hands = new Map<string, PhysicalCard[]>();
    playerIds.forEach(id => hands.set(id, []));

    const allCards: PhysicalCard[] = [];
    let cardIdx = 0;

    for (let pIdx = 0; pIdx < playerIds.length; pIdx++) {
      const pId = playerIds[pIdx];
      const playerHand: PhysicalCard[] = [];
      for (let c = 0; c < 4; c++) {
        const card = { ...shuffledDeck[cardIdx] };
        card.currentOwnerId = pId;
        card.position = c;
        playerHand.push(card);
        allCards.push(card);
        cardIdx++;
      }
      hands.set(pId, playerHand);
    }

    return { hands, allCards };
  }

  /**
   * Validates whether a player owns 4 matching cards of the exact same CardType.
   */
  public static validateWinningHand(hand: PhysicalCard[]): {
    isValid: boolean;
    cardTypeId?: string;
    cardName?: string;
    cardImageUrl?: string;
    reason?: string;
  } {
    if (!hand || hand.length !== 4) {
      return {
        isValid: false,
        reason: `Player must have exactly 4 cards to declare winner, currently has ${hand ? hand.length : 0}.`,
      };
    }

    const firstType = hand[0].cardTypeId;
    const allMatch = hand.every(c => c.cardTypeId === firstType);

    if (!allMatch) {
      return {
        isValid: false,
        reason: "You don't have four matching cards yet!",
      };
    }

    return {
      isValid: true,
      cardTypeId: firstType,
      cardName: hand[0].cardName,
      cardImageUrl: hand[0].cardImageUrl,
    };
  }

  /**
   * Helper to find next player clockwise in circular array
   */
  public static getNextPlayerClockwise(playerOrder: string[], currentPlayerId: string): string {
    const idx = playerOrder.indexOf(currentPlayerId);
    if (idx === -1) {
      throw new Error(`Player ${currentPlayerId} not found in player order.`);
    }
    const nextIdx = (idx + 1) % playerOrder.length;
    return playerOrder[nextIdx];
  }
}
