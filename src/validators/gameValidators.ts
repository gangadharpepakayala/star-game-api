export class GameValidators {
  public static validateRoomName(name: string): { valid: boolean; error?: string } {
    if (!name || name.trim().length < 3 || name.trim().length > 30) {
      return { valid: false, error: 'Room name must be between 3 and 30 characters.' };
    }
    return { valid: true };
  }

  public static validateMaxPlayers(max: number): { valid: boolean; error?: string } {
    if (!Number.isInteger(max) || max < 2 || max > 15) {
      return { valid: false, error: 'Max players must be an integer between 2 and 15.' };
    }
    return { valid: true };
  }

  public static validateTotalRounds(rounds: number): { valid: boolean; error?: string } {
    if (!Number.isInteger(rounds) || rounds < 1 || rounds > 20) {
      return { valid: false, error: 'Total rounds must be an integer between 1 and 20.' };
    }
    return { valid: true };
  }

  public static validateCardName(
    cardName: string,
    existingNames: string[] = []
  ): { valid: boolean; error?: string } {
    if (!cardName || cardName.trim().length < 2 || cardName.trim().length > 24) {
      return { valid: false, error: 'Card name must be between 2 and 24 characters.' };
    }

    const trimmed = cardName.trim().toLowerCase();
    const isDuplicate = (existingNames || []).some(
      existing => existing && existing.trim().toLowerCase() === trimmed
    );

    if (isDuplicate) {
      return { valid: false, error: `Card name "${cardName.trim()}" is already taken in this room. Please choose a different card name.` };
    }

    return { valid: true };
  }

  public static validatePlayerName(name: string): { valid: boolean; error?: string } {
    if (!name || name.trim().length < 2 || name.trim().length > 20) {
      return { valid: false, error: 'Player name must be between 2 and 20 characters.' };
    }
    return { valid: true };
  }
}
