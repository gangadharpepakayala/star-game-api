export type RoomVisibility = 'PUBLIC' | 'PRIVATE';

export type RoomStatus = 
  | 'WAITING' 
  | 'STARTING' 
  | 'IN_PROGRESS' 
  | 'ROUND_COMPLETED' 
  | 'COMPLETED' 
  | 'CANCELLED' 
  | 'EXPIRED';

export type MatchStatus = 'IN_PROGRESS' | 'COMPLETED' | 'CANCELLED';
export type RoundStatus = 'IN_PROGRESS' | 'COMPLETED' | 'CANCELLED';

export interface PlayerProfile {
  id: string;
  playerName: string;
  avatarUrl: string;
  createdBy?: string;
  createdDateTime: string;
  updatedBy?: string;
  updatedDateTime: string;
  status: string;
}

export interface PlayerSession {
  token: string;
  playerId: string;
  playerName: string;
  avatarUrl: string;
}

export interface SubmittedCard {
  id: string;
  roomId: string;
  playerId: string;
  cardName: string;
  cardImageUrl?: string;
  createdBy?: string;
  createdDateTime: string;
  updatedBy?: string;
  updatedDateTime: string;
  status: string;
}

export interface PhysicalCard {
  id: string; // e.g. CARD_DRAGON_1
  cardTypeId: string; // ID of the player who submitted it or card type slug
  cardName: string;
  cardImageUrl?: string;
  currentOwnerId: string;
  position: number;
}

export interface PublicPlayerInfo {
  id: string;
  name: string;
  avatarUrl: string;
  isHost: boolean;
  isReady: boolean;
  isConnected: boolean;
  submittedCardName?: string;
  submittedCardImage?: string;
  cardCount: number;
  totalPoints: number;
  roundWins: number;
  isTurn: boolean;
}

export interface PublicRoomState {
  roomId: string;
  roomCode: string;
  roomName: string;
  hostPlayerId: string;
  maxPlayers: number;
  totalRounds: number;
  currentRound: number;
  roomVisibility: RoomVisibility;
  roomStatus: RoomStatus;
  currentTurnPlayerId: string | null;
  turnTimeRemaining: number;
  players: PublicPlayerInfo[];
  turnOrder?: string[];
  lastExchange?: {
    fromPlayerId: string;
    toPlayerId: string;
    timestamp: number;
  };
  roundWinner?: {
    playerId: string;
    playerName: string;
    cardName: string;
    cardImageUrl?: string;
    pointsAwarded: number;
  };
  finalChampion?: {
    playerId: string;
    playerName: string;
    avatarUrl: string;
    totalPoints: number;
    totalWins: number;
  };
}

export interface PrivatePlayerState {
  playerId: string;
  hand: PhysicalCard[];
}

export interface LeaderboardEntry {
  rank: number;
  playerId: string;
  playerName: string;
  avatarUrl: string;
  roundWins: number;
  totalPoints: number;
  totalGames?: number;
  completedRounds?: number;
  remainingRounds?: number;
}
