import { PublicRoomState, PhysicalCard, LeaderboardEntry } from './types';

export type ClientEventType =
  | 'join_room'
  | 'submit_card'
  | 'player_ready'
  | 'start_game'
  | 'exchange_card'
  | 'declare_winner'
  | 'request_next_round'
  | 'end_game'
  | 'leave_room'
  | 'heartbeat';

export type ServerEventType =
  | 'room_updated'
  | 'player_joined'
  | 'player_left'
  | 'player_ready_updated'
  | 'game_started'
  | 'cards_distributed'
  | 'turn_started'
  | 'card_exchanged'
  | 'private_hand_updated'
  | 'timer_updated'
  | 'winner_validated'
  | 'invalid_winner_claim'
  | 'round_completed'
  | 'round_countdown_started'
  | 'leaderboard_updated'
  | 'next_round_started'
  | 'game_completed'
  | 'player_disconnected'
  | 'player_reconnected'
  | 'error';

export interface BaseSocketMessage<T extends string, P = any> {
  event: T;
  roomId: string;
  payload: P;
}

// Client Payloads
export interface JoinRoomPayload {
  token: string;
  playerId: string;
  playerName?: string;
  avatarUrl?: string;
}

export interface SubmitCardPayload {
  token: string;
  cardName: string;
  cardImageUrl?: string;
  playerName?: string;
}

export interface PlayerReadyPayload {
  token: string;
  isReady: boolean;
}

export interface StartGamePayload {
  token: string;
}

export interface ExchangeCardPayload {
  token: string;
  cardId: string;
}

export interface DeclareWinnerPayload {
  token: string;
}

export interface RequestNextRoundPayload {
  token: string;
}

export interface EndGamePayload {
  token: string;
}

export interface LeaveRoomPayload {
  token: string;
}

// Server Payloads
export interface RoomUpdatedPayload {
  room: PublicRoomState;
}

export interface PrivateHandUpdatedPayload {
  cards: PhysicalCard[];
}

export interface TurnStartedPayload {
  playerId: string;
  turnTimeSeconds: number;
}

export interface TimerUpdatedPayload {
  playerId: string;
  remainingSeconds: number;
}

export interface CardExchangedPayload {
  fromPlayerId: string;
  toPlayerId: string;
  nextTurnPlayerId: string;
}

export interface WinnerValidatedPayload {
  winnerPlayerId: string;
  winnerPlayerName: string;
  cardName: string;
  cardImageUrl?: string;
  points: number;
  matchingCards: PhysicalCard[];
}

export interface RoundCompletedPayload {
  roundNumber: number;
  winnerPlayerId: string;
  winnerPlayerName: string;
  leaderboard: LeaderboardEntry[];
  isFinalRound: boolean;
}

export interface RoundCountdownStartedPayload {
  countdownSeconds: number;
  nextRoundNumber: number;
}

export interface GameCompletedPayload {
  championPlayerId: string;
  championPlayerName: string;
  championAvatar: string;
  finalLeaderboard: LeaderboardEntry[];
  endedByHost?: boolean;
}

export interface ErrorPayload {
  message: string;
  code?: string;
}

export type ClientMessage =
  | BaseSocketMessage<'join_room', JoinRoomPayload>
  | BaseSocketMessage<'submit_card', SubmitCardPayload>
  | BaseSocketMessage<'player_ready', PlayerReadyPayload>
  | BaseSocketMessage<'start_game', StartGamePayload>
  | BaseSocketMessage<'exchange_card', ExchangeCardPayload>
  | BaseSocketMessage<'declare_winner', DeclareWinnerPayload>
  | BaseSocketMessage<'request_next_round', RequestNextRoundPayload>
  | BaseSocketMessage<'end_game', EndGamePayload>
  | BaseSocketMessage<'leave_room', LeaveRoomPayload>
  | BaseSocketMessage<'heartbeat', { token: string }>;
