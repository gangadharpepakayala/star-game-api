import { describe, it, expect } from 'vitest';
import { CardEngine } from '../src/services/cardEngine';
import { GameValidators } from '../src/validators/gameValidators';
import { PhysicalCard, SubmittedCard } from '../src/models/types';

describe('Star Game Engine & Rules Unit Tests', () => {
  // Test 4: Duplicate card rejection
  it('should reject duplicate card names regardless of case', () => {
    const existing = ['Star', 'Dragon', 'Phoenix'];
    const res1 = GameValidators.validateCardName('star', existing);
    expect(res1.valid).toBe(false);
    expect(res1.error).toContain('already taken');

    const res2 = GameValidators.validateCardName('Tiger', existing);
    expect(res2.valid).toBe(true);

    const res3 = GameValidators.validateCardName('Tiger');
    expect(res3.valid).toBe(true);
  });

  // Test 6, 9: Generate four copies of each card type & total card count
  it('should generate exactly four copies of each card type', () => {
    const submissions: SubmittedCard[] = [
      { id: '1', roomId: 'r1', playerId: 'p1', cardName: 'STAR', createdDateTime: '', updatedDateTime: '', status: 'ACTIVE' },
      { id: '2', roomId: 'r1', playerId: 'p2', cardName: 'DRAGON', createdDateTime: '', updatedDateTime: '', status: 'ACTIVE' },
      { id: '3', roomId: 'r1', playerId: 'p3', cardName: 'PHOENIX', createdDateTime: '', updatedDateTime: '', status: 'ACTIVE' },
    ];

    const deck = CardEngine.generateDeck(submissions);
    // Total cards = players * 4 = 12
    expect(deck.length).toBe(12);

    const starCopies = deck.filter(c => c.cardName === 'STAR');
    expect(starCopies.length).toBe(4);

    const dragonCopies = deck.filter(c => c.cardName === 'DRAGON');
    expect(dragonCopies.length).toBe(4);

    const phoenixCopies = deck.filter(c => c.cardName === 'PHOENIX');
    expect(phoenixCopies.length).toBe(4);
  });

  // Test 7: Shuffling
  it('should shuffle deck without losing any cards', () => {
    const submissions: SubmittedCard[] = [
      { id: '1', roomId: 'r1', playerId: 'p1', cardName: 'JUNGLE', createdDateTime: '', updatedDateTime: '', status: 'ACTIVE' },
      { id: '2', roomId: 'r1', playerId: 'p2', cardName: 'PANTHER', createdDateTime: '', updatedDateTime: '', status: 'ACTIVE' },
    ];

    const deck = CardEngine.generateDeck(submissions);
    const shuffled = CardEngine.shuffleDeck(deck);

    expect(shuffled.length).toBe(deck.length);
    // All card IDs should still be present
    const originalIds = new Set(deck.map(c => c.id));
    for (const c of shuffled) {
      expect(originalIds.has(c.id)).toBe(true);
    }
  });

  // Test 8: Distribute four cards per player
  it('should distribute exactly four cards to every player', () => {
    const playerIds = ['player_1', 'player_2', 'player_3'];
    const submissions: SubmittedCard[] = playerIds.map((pId, idx) => ({
      id: `${idx}`,
      roomId: 'r1',
      playerId: pId,
      cardName: `CARD_${idx}`,
      createdDateTime: '',
      updatedDateTime: '',
      status: 'ACTIVE',
    }));

    const deck = CardEngine.shuffleDeck(CardEngine.generateDeck(submissions));
    const { hands, allCards } = CardEngine.dealCards(deck, playerIds);

    expect(hands.size).toBe(3);
    for (const pId of playerIds) {
      const hand = hands.get(pId)!;
      expect(hand.length).toBe(4);
      hand.forEach(c => expect(c.currentOwnerId).toBe(pId));
    }
    expect(allCards.length).toBe(12);
  });

  // Test 12: Turn order clockwise
  it('should rotate turn order strictly clockwise in a circular ring', () => {
    const playerOrder = ['pA', 'pB', 'pC'];
    expect(CardEngine.getNextPlayerClockwise(playerOrder, 'pA')).toBe('pB');
    expect(CardEngine.getNextPlayerClockwise(playerOrder, 'pB')).toBe('pC');
    expect(CardEngine.getNextPlayerClockwise(playerOrder, 'pC')).toBe('pA');
  });

  // Test 14 & 15: Winner declaration validation
  it('should validate winner only when player has exactly 4 matching cards', () => {
    const winningHand: PhysicalCard[] = [
      { id: 'c1', cardTypeId: 'type_star', cardName: 'STAR', currentOwnerId: 'p1', position: 0 },
      { id: 'c2', cardTypeId: 'type_star', cardName: 'STAR', currentOwnerId: 'p1', position: 1 },
      { id: 'c3', cardTypeId: 'type_star', cardName: 'STAR', currentOwnerId: 'p1', position: 2 },
      { id: 'c4', cardTypeId: 'type_star', cardName: 'STAR', currentOwnerId: 'p1', position: 3 },
    ];

    const resultValid = CardEngine.validateWinningHand(winningHand);
    expect(resultValid.isValid).toBe(true);
    expect(resultValid.cardName).toBe('STAR');

    const mixedHand: PhysicalCard[] = [
      { id: 'c1', cardTypeId: 'type_star', cardName: 'STAR', currentOwnerId: 'p1', position: 0 },
      { id: 'c2', cardTypeId: 'type_star', cardName: 'STAR', currentOwnerId: 'p1', position: 1 },
      { id: 'c3', cardTypeId: 'type_star', cardName: 'STAR', currentOwnerId: 'p1', position: 2 },
      { id: 'c5', cardTypeId: 'type_dragon', cardName: 'DRAGON', currentOwnerId: 'p1', position: 3 },
    ];

    const resultInvalid = CardEngine.validateWinningHand(mixedHand);
    expect(resultInvalid.isValid).toBe(false);
    expect(resultInvalid.reason).toBe("You don't have four matching cards yet!");

    const incompleteHand = winningHand.slice(0, 3);
    const resultIncomplete = CardEngine.validateWinningHand(incompleteHand);
    expect(resultIncomplete.isValid).toBe(false);
  });

  // Test validators
  it('should validate room and player parameters properly', () => {
    expect(GameValidators.validateRoomName('AB').valid).toBe(false);
    expect(GameValidators.validateRoomName('Jungle Room').valid).toBe(true);

    expect(GameValidators.validateMaxPlayers(1).valid).toBe(false);
    expect(GameValidators.validateMaxPlayers(16).valid).toBe(false);
    expect(GameValidators.validateMaxPlayers(15).valid).toBe(true);
    expect(GameValidators.validateMaxPlayers(4).valid).toBe(true);

    expect(GameValidators.validateTotalRounds(0).valid).toBe(false);
    expect(GameValidators.validateTotalRounds(5).valid).toBe(true);
  });
});
