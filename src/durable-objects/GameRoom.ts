import { DurableObject } from 'cloudflare:workers';
import { Env, DatabaseRepository } from '../repositories/db';
import { 
  PublicRoomState, 
  PublicPlayerInfo, 
  PhysicalCard, 
  SubmittedCard, 
  LeaderboardEntry,
  RoomStatus 
} from '../models/types';
import { 
  ClientMessage, 
  BaseSocketMessage, 
  ServerEventType 
} from '../models/events';
import { CardEngine } from '../services/cardEngine';
import { GameValidators } from '../validators/gameValidators';

interface StoredRoomState {
  roomId: string;
  roomCode: string;
  roomName: string;
  hostPlayerId: string;
  maxPlayers: number;
  totalRounds: number;
  currentRound: number;
  roomVisibility: 'PUBLIC' | 'PRIVATE';
  passwordHash?: string;
  roomStatus: RoomStatus;
  isPaused?: boolean;
  pausedByPlayerName?: string;
  currentTurnPlayerId: string | null;
  turnTimeRemaining: number;
  turnStartedTimestamp: number;
  matchId: string | null;
  turnOrder: string[];
  players: Record<string, {
    id: string;
    name: string;
    avatarUrl: string;
    isHost: boolean;
    isReady: boolean;
    isConnected: boolean;
    submittedCardName?: string;
    submittedCardImage?: string;
    totalPoints: number;
    roundWins: number;
    lastActive: number;
  }>;
  playerHands: Record<string, PhysicalCard[]>;
  submittedCards: SubmittedCard[];
}

export class GameRoom extends DurableObject<Env> {
  private sessions: Map<WebSocket, { playerId: string; token: string }> = new Map();
  private timerInterval: any = null;
  private stateCache: StoredRoomState | null = null;
  private dbRepo: DatabaseRepository;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.dbRepo = new DatabaseRepository(env.DB);
  }

  /**
   * Loads room state from SQLite storage or initializes if not present.
   */
  private async getRoomState(): Promise<StoredRoomState | null> {
    if (this.stateCache) return this.stateCache;
    const stored = await this.ctx.storage.get<StoredRoomState>('room_state');
    if (stored) {
      this.stateCache = stored;
      return stored;
    }
    return null;
  }

  private sanitizeStateForStorage(state: StoredRoomState): StoredRoomState {
    // 1. Remove duplicate cardImageUrl from physical cards in playerHands to prevent SQLite bloat
    if (state.playerHands) {
      for (const pId of Object.keys(state.playerHands)) {
        for (const card of state.playerHands[pId]) {
          delete card.cardImageUrl;
        }
      }
    }

    // 2. Cap submittedCards images to max 64KB
    if (state.submittedCards) {
      for (const card of state.submittedCards) {
        if (card.cardImageUrl && card.cardImageUrl.length > 65536) {
          card.cardImageUrl = undefined;
        }
      }
    }

    // 3. Cap players submittedCardImage to max 64KB
    if (state.players) {
      for (const pId of Object.keys(state.players)) {
        const p = state.players[pId];
        if (p.submittedCardImage && p.submittedCardImage.length > 65536) {
          p.submittedCardImage = undefined;
        }
      }
    }

    return state;
  }

  private async saveRoomState(state: StoredRoomState): Promise<void> {
    this.stateCache = state;
    const safeState = this.sanitizeStateForStorage(state);
    await this.ctx.storage.put('room_state', safeState);
  }

  /**
   * Initializes a new room in Durable Object storage.
   */
  public async initializeRoom(config: {
    roomId: string;
    roomCode: string;
    roomName: string;
    hostPlayerId: string;
    hostPlayerName: string;
    hostAvatarUrl: string;
    hostCardName?: string;
    hostCardImage?: string;
    maxPlayers: number;
    totalRounds: number;
    roomVisibility: 'PUBLIC' | 'PRIVATE';
    passwordHash?: string;
  }): Promise<StoredRoomState> {
    const isReady = !!(config.hostCardName && config.hostCardName.trim());
    const submittedCards: SubmittedCard[] = [];

    if (config.hostCardName && config.hostCardName.trim()) {
      submittedCards.push({
        id: `card_${config.hostPlayerId}`,
        roomId: config.roomId,
        playerId: config.hostPlayerId,
        cardName: config.hostCardName.trim(),
        cardImageUrl: config.hostCardImage,
        createdDateTime: new Date().toISOString(),
        updatedDateTime: new Date().toISOString(),
        status: 'ACTIVE',
      });
    }

    const state: StoredRoomState = {
      roomId: config.roomId,
      roomCode: config.roomCode,
      roomName: config.roomName,
      hostPlayerId: config.hostPlayerId,
      maxPlayers: Number(config.maxPlayers),
      totalRounds: Number(config.totalRounds),
      currentRound: 1,
      roomVisibility: config.roomVisibility,
      passwordHash: config.passwordHash,
      roomStatus: 'WAITING',
      currentTurnPlayerId: null,
      turnTimeRemaining: 30,
      turnStartedTimestamp: 0,
      matchId: null,
      turnOrder: [config.hostPlayerId],
      players: {
        [config.hostPlayerId]: {
          id: config.hostPlayerId,
          name: config.hostPlayerName,
          avatarUrl: config.hostAvatarUrl,
          isHost: true,
          isReady: isReady,
          isConnected: true,
          submittedCardName: config.hostCardName ? config.hostCardName.trim() : undefined,
          submittedCardImage: config.hostCardImage,
          totalPoints: 0,
          roundWins: 0,
          lastActive: Date.now(),
        },
      },
      playerHands: {},
      submittedCards,
    };

    await this.saveRoomState(state);

    // Schedule automatic room expiration after 2 hours (2 * 60 * 60 * 1000 ms)
    const TWO_HOURS_MS = 2 * 60 * 60 * 1000;
    await this.ctx.storage.setAlarm(Date.now() + TWO_HOURS_MS);

    return state;
  }

  /**
   * Cloudflare Durable Object Alarm: automatically triggered 2 hours after room creation
   */
  override async alarm(): Promise<void> {
    const state = await this.getRoomState();
    if (state) {
      state.roomStatus = 'EXPIRED';
      this.broadcast('error', { message: 'This room has expired after 2 hours.' });

      for (const [ws] of this.sessions.entries()) {
        try {
          ws.close(1000, 'Room expired after 2 hours');
        } catch {}
      }
      this.sessions.clear();

      if (this.timerInterval) {
        clearInterval(this.timerInterval);
        this.timerInterval = null;
      }

      await this.dbRepo.expireRoom(state.roomId);
      await this.ctx.storage.deleteAll();
      this.stateCache = null;
    }
  }

  /**
   * Entrypoint for HTTP/WebSocket requests to this Durable Object.
   */
  override async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);

    // REST: Get room state directly from DO
    if (url.pathname.endsWith('/state') && request.method === 'GET') {
      const state = await this.getRoomState();
      if (!state || state.roomStatus === 'EXPIRED') {
        return new Response(JSON.stringify({ error: 'Room has expired' }), { status: 410 });
      }
      return new Response(JSON.stringify(this.buildPublicRoomState(state)), {
        headers: { 'Content-Type': 'application/json' },
      });
    }

    // REST: Initialize room
    if (url.pathname.endsWith('/init') && request.method === 'POST') {
      const body = await request.json<any>();
      const state = await this.initializeRoom(body);
      return new Response(JSON.stringify(this.buildPublicRoomState(state)), {
        headers: { 'Content-Type': 'application/json' },
      });
    }

    // WebSocket upgrade
    if (request.headers.get('Upgrade') === 'websocket') {
      const state = await this.getRoomState();
      if (!state || state.roomStatus === 'EXPIRED') {
        return new Response('Room has expired', { status: 410 });
      }
      const token = url.searchParams.get('token') || '';
      const playerId = url.searchParams.get('playerId') || '';

      const pair = new WebSocketPair();
      const [clientWs, serverWs] = Object.values(pair);

      await this.handleWebSocketSession(serverWs, playerId, token);

      return new Response(null, {
        status: 101,
        webSocket: clientWs,
      });
    }

    return new Response('Not Found', { status: 404 });
  }

  /**
   * Handle incoming WebSocket connection
   */
  private async handleWebSocketSession(ws: WebSocket, playerId: string, token: string): Promise<void> {
    ws.accept();
    this.sessions.set(ws, { playerId, token });

    const state = await this.getRoomState();
    if (state && playerId && state.players[playerId]) {
      state.players[playerId].isConnected = true;
      state.players[playerId].lastActive = Date.now();
      await this.saveRoomState(state);

      // Notify player reconnected
      this.broadcast('player_reconnected', { playerId, name: state.players[playerId].name });
      this.sendPrivateState(ws, playerId, state);
      this.broadcastRoomUpdate(state);
    }

    ws.addEventListener('message', async (event: MessageEvent) => {
      try {
        const message: ClientMessage = JSON.parse(event.data as string);
        await this.handleClientMessage(ws, message);
      } catch (err: any) {
        this.sendError(ws, err.message || 'Invalid message payload');
      }
    });

    ws.addEventListener('close', async () => {
      const session = this.sessions.get(ws);
      this.sessions.delete(ws);
      if (session) {
        await this.handlePlayerDisconnect(session.playerId);
      }
    });

    ws.addEventListener('error', () => {
      this.sessions.delete(ws);
    });
  }

  /**
   * Handle player disconnect, grace period, and host migration
   */
  private async handlePlayerDisconnect(playerId: string): Promise<void> {
    const state = await this.getRoomState();
    if (!state || !state.players[playerId]) return;

    state.players[playerId].isConnected = false;
    state.players[playerId].lastActive = Date.now();

    // If room is WAITING and player leaves, handle host migration if needed
    if (state.players[playerId].isHost) {
      const otherConnected = Object.values(state.players).find(p => p.id !== playerId && p.isConnected);
      if (otherConnected) {
        state.players[playerId].isHost = false;
        otherConnected.isHost = true;
        state.hostPlayerId = otherConnected.id;
      }
    }

    await this.saveRoomState(state);
    this.broadcast('player_disconnected', { playerId });
    this.broadcastRoomUpdate(state);
  }

  /**
   * Route incoming WebSocket client messages
   */
  private async handleClientMessage(ws: WebSocket, message: ClientMessage): Promise<void> {
    const state = await this.getRoomState();
    if (!state) {
      this.sendError(ws, 'Room does not exist or has expired.');
      return;
    }

    const session = this.sessions.get(ws);
    const playerId = session?.playerId || (message.payload as any).playerId;

    switch (message.event) {
      case 'join_room': {
        await this.onPlayerJoin(ws, playerId, (message.payload as any).playerName, (message.payload as any).avatarUrl, state);
        break;
      }
      case 'submit_card': {
        const p = message.payload as any;
        await this.onSubmitCard(ws, playerId, p.cardName, p.cardImageUrl, p.playerName, state);
        break;
      }
      case 'player_ready': {
        await this.onPlayerReady(ws, playerId, message.payload.isReady, state);
        break;
      }
      case 'start_game': {
        await this.onStartGame(ws, playerId, state);
        break;
      }
      case 'exchange_card': {
        await this.onExchangeCard(ws, playerId, message.payload.cardId, state);
        break;
      }
      case 'declare_winner': {
        await this.onDeclareWinner(ws, playerId, state);
        break;
      }
      case 'request_next_round': {
        await this.onRequestNextRound(ws, playerId, state);
        break;
      }
      case 'pause_game': {
        await this.onPauseGame(ws, playerId, state);
        break;
      }
      case 'resume_game': {
        await this.onResumeGame(ws, playerId, state);
        break;
      }
      case 'end_game': {
        await this.onEndGame(ws, playerId, state);
        break;
      }
      case 'leave_room': {
        await this.onLeaveRoom(ws, playerId, state);
        break;
      }
      case 'heartbeat': {
        if (state.players[playerId]) {
          state.players[playerId].lastActive = Date.now();
        }
        break;
      }
      default:
        this.sendError(ws, `Unsupported event: ${(message as any).event}`);
    }
  }

  /**
   * Player joins the room
   */
  private async onPlayerJoin(
    ws: WebSocket,
    playerId: string,
    playerName: string | undefined,
    avatarUrl: string | undefined,
    state: StoredRoomState
  ): Promise<void> {
    const validName = playerName && playerName.trim() && !playerName.startsWith('Player ply_')
      ? playerName.trim()
      : undefined;

    if (!state.players[playerId]) {
      // Check room capacity
      const activeCount = Object.keys(state.players).length;
      if (activeCount >= state.maxPlayers) {
        this.sendError(ws, 'Room is already full.');
        return;
      }

      if (state.roomStatus !== 'WAITING') {
        this.sendError(ws, 'Game has already started.');
        return;
      }

      state.players[playerId] = {
        id: playerId,
        name: validName || `Adventurer ${playerId.slice(4, 8) || playerId.slice(0, 4)}`,
        avatarUrl: avatarUrl || `https://api.dicebear.com/7.x/bottts/svg?seed=${playerId}`,
        isHost: Object.keys(state.players).length === 0,
        isReady: false,
        isConnected: true,
        totalPoints: 0,
        roundWins: 0,
        lastActive: Date.now(),
      };

      if (!state.turnOrder.includes(playerId)) {
        state.turnOrder.push(playerId);
      }
    } else {
      state.players[playerId].isConnected = true;
      if (validName) state.players[playerId].name = validName;
      if (avatarUrl) state.players[playerId].avatarUrl = avatarUrl;
    }

    this.sessions.set(ws, { playerId, token: '' });
    await this.saveRoomState(state);

    this.broadcast('player_joined', { player: state.players[playerId] });
    this.sendPrivateState(ws, playerId, state);
    this.broadcastRoomUpdate(state);
  }

  /**
   * Submit unique card type for this player
   */
  private async onSubmitCard(
    ws: WebSocket,
    playerId: string,
    cardName: string,
    cardImageUrl: string | undefined,
    playerName: string | undefined,
    state: StoredRoomState
  ): Promise<void> {
    if (state.roomStatus !== 'WAITING') {
      this.sendError(ws, 'Cannot change cards once game has started.');
      return;
    }

    const player = state.players[playerId];
    if (!player) {
      this.sendError(ws, 'Player not found in room.');
      return;
    }

    // Update player's custom name if provided
    if (playerName && playerName.trim() && !playerName.startsWith('Player ply_')) {
      player.name = playerName.trim();
      this.ctx.waitUntil(this.dbRepo.updatePlayerProfile(playerId, player.name));
    }

    // Check duplicate card name across other players
    const otherCardNames = Object.entries(state.players)
      .filter(([id]) => id !== playerId)
      .map(([_, p]) => p.submittedCardName)
      .filter((name): name is string => !!name);

    const validation = GameValidators.validateCardName(cardName, otherCardNames);
    if (!validation.valid) {
      this.sendError(ws, validation.error!);
      return;
    }

    player.submittedCardName = cardName.trim();
    player.submittedCardImage = cardImageUrl;
    player.isReady = true; // Auto-ready upon submission or ready toggle

    // Record in submittedCards list
    const existingIndex = state.submittedCards.findIndex(c => c.playerId === playerId);
    const subCard: SubmittedCard = {
      id: `card_${playerId}`,
      roomId: state.roomId,
      playerId,
      cardName: cardName.trim(),
      cardImageUrl,
      createdDateTime: new Date().toISOString(),
      updatedDateTime: new Date().toISOString(),
      status: 'ACTIVE',
    };

    if (existingIndex >= 0) {
      state.submittedCards[existingIndex] = subCard;
    } else {
      state.submittedCards.push(subCard);
    }

    await this.saveRoomState(state);
    this.broadcast('player_ready_updated', {
      playerId,
      isReady: player.isReady,
      cardName: player.submittedCardName,
      cardImageUrl: player.submittedCardImage,
    });
    this.broadcastRoomUpdate(state);
  }

  /**
   * Player toggles ready status
   */
  private async onPlayerReady(ws: WebSocket, playerId: string, isReady: boolean, state: StoredRoomState): Promise<void> {
    if (state.roomStatus !== 'WAITING') return;

    const player = state.players[playerId];
    if (!player) return;

    if (isReady && !player.submittedCardName) {
      this.sendError(ws, 'Please submit your unique card name before becoming ready.');
      return;
    }

    player.isReady = isReady;
    await this.saveRoomState(state);

    this.broadcast('player_ready_updated', { playerId, isReady });
    this.broadcastRoomUpdate(state);
  }

  /**
   * Host starts the game
   */
  private async onStartGame(ws: WebSocket, playerId: string, state: StoredRoomState): Promise<void> {
    const player = state.players[playerId];
    if (!player || !player.isHost) {
      this.sendError(ws, 'Only the room host can start the game.');
      return;
    }

    const playerList = Object.values(state.players);
    if (playerList.length < 2) {
      this.sendError(ws, 'At least 2 players are required to start the game.');
      return;
    }

    const unreadyPlayer = playerList.find(p => !p.isReady || !p.submittedCardName);
    if (unreadyPlayer) {
      this.sendError(ws, `Waiting for ${unreadyPlayer.name} to submit a card and become ready.`);
      return;
    }

    state.matchId = `match_${state.roomId}_${Date.now()}`;
    state.currentRound = 1;
    await this.startRound(state);
  }

  /**
   * Sets up and starts a new round: generates cards, shuffles, distributes, starts turn timer.
   */
  private async startRound(state: StoredRoomState): Promise<void> {
    state.roomStatus = 'IN_PROGRESS';
    state.turnOrder = Object.keys(state.players);

    // 1. Generate 4 copies of each submitted card
    const deck = CardEngine.generateDeck(state.submittedCards);

    // 2. Cryptographically secure shuffle
    const shuffled = CardEngine.shuffleDeck(deck);

    // 3. Deal exactly 4 cards to each player
    const { hands } = CardEngine.dealCards(shuffled, state.turnOrder);

    state.playerHands = {};
    for (const [pId, hand] of hands.entries()) {
      state.playerHands[pId] = hand;
    }

    // First turn goes randomly to any player in the room
    const randomStartIndex = Math.floor(Math.random() * state.turnOrder.length);
    state.currentTurnPlayerId = state.turnOrder[randomStartIndex];
    state.turnTimeRemaining = 30;
    state.turnStartedTimestamp = Date.now();

    await this.saveRoomState(state);

    // Broadcast game start and private hands
    this.broadcast('game_started', {
      roundNumber: state.currentRound,
      totalRounds: state.totalRounds,
      turnPlayerId: state.currentTurnPlayerId,
    });

    this.broadcastPrivateHands(state);
    this.broadcastRoomUpdate(state);

    this.startTurnTimer();
  }

  /**
   * Turn timer management with 30s limit and auto-card pass
   */
  private startTurnTimer(): void {
    if (this.timerInterval) {
      clearInterval(this.timerInterval);
    }

    this.timerInterval = setInterval(async () => {
      const state = await this.getRoomState();
      if (!state || state.roomStatus !== 'IN_PROGRESS' || !state.currentTurnPlayerId) {
        clearInterval(this.timerInterval);
        return;
      }

      if (state.isPaused) {
        // Paused by host: do not count down the timer
        return;
      }

      state.turnTimeRemaining = Math.max(0, state.turnTimeRemaining - 1);

      if (state.turnTimeRemaining <= 0) {
        // Auto-pass a random card from current player's hand!
        await this.handleTurnTimeout(state);
      } else {
        await this.saveRoomState(state);
        this.broadcast('timer_updated', {
          playerId: state.currentTurnPlayerId,
          remainingSeconds: state.turnTimeRemaining,
        });
      }
    }, 1000);
  }

  /**
   * Turn timeout: randomly pass a card to the next player clockwise
   */
  private async handleTurnTimeout(state: StoredRoomState): Promise<void> {
    const curPlayerId = state.currentTurnPlayerId;
    if (!curPlayerId) return;

    const hand = state.playerHands[curPlayerId];
    if (hand && hand.length > 0) {
      // Pick random card
      const randomIndex = Math.floor(Math.random() * hand.length);
      const randomCard = hand[randomIndex];
      await this.performCardExchange(curPlayerId, randomCard.id, state);
    } else {
      // Rotate turn
      state.currentTurnPlayerId = CardEngine.getNextPlayerClockwise(state.turnOrder, curPlayerId);
      state.turnTimeRemaining = 30;
      state.turnStartedTimestamp = Date.now();
      await this.saveRoomState(state);
      this.broadcast('turn_started', {
        playerId: state.currentTurnPlayerId,
        turnTimeSeconds: 30,
      });
      this.broadcastRoomUpdate(state);
    }
  }

  /**
   * Player passes a card to the next player clockwise
   */
  private async onExchangeCard(
    ws: WebSocket,
    playerId: string,
    cardId: string,
    state: StoredRoomState
  ): Promise<void> {
    if (state.roomStatus !== 'IN_PROGRESS') {
      this.sendError(ws, 'No active round in progress.');
      return;
    }

    if (state.isPaused) {
      this.sendError(ws, 'The game is currently paused by the host.');
      return;
    }

    if (state.currentTurnPlayerId !== playerId) {
      this.sendError(ws, 'It is not your turn to exchange a card.');
      return;
    }

    const hand = state.playerHands[playerId] || [];
    const cardIndex = hand.findIndex(c => c.id === cardId);

    if (cardIndex === -1) {
      this.sendError(ws, 'You do not own this card.');
      return;
    }

    await this.performCardExchange(playerId, cardId, state);
  }

  /**
   * Core clockwise card exchange logic
   */
  private async performCardExchange(
    fromPlayerId: string,
    cardId: string,
    state: StoredRoomState
  ): Promise<void> {
    const fromHand = state.playerHands[fromPlayerId];
    const cardIndex = fromHand.findIndex(c => c.id === cardId);
    if (cardIndex === -1) return;

    const [passedCard] = fromHand.splice(cardIndex, 1);
    const nextPlayerId = CardEngine.getNextPlayerClockwise(state.turnOrder, fromPlayerId);
    const nextHand = state.playerHands[nextPlayerId] || [];

    passedCard.currentOwnerId = nextPlayerId;
    nextHand.push(passedCard);

    state.currentTurnPlayerId = nextPlayerId;
    state.turnTimeRemaining = 30;
    state.turnStartedTimestamp = Date.now();

    await this.saveRoomState(state);

    // Notify card exchange
    this.broadcast('card_exchanged', {
      fromPlayerId,
      toPlayerId: nextPlayerId,
      nextTurnPlayerId: nextPlayerId,
    });

    this.broadcast('turn_started', {
      playerId: nextPlayerId,
      turnTimeSeconds: 30,
    });

    // Update hands privately to the involved players
    this.broadcastPrivateHands(state);
    this.broadcastRoomUpdate(state);
  }

  /**
   * Winner Declaration Validation
   */
  private async onDeclareWinner(ws: WebSocket, playerId: string, state: StoredRoomState): Promise<void> {
    if (state.roomStatus !== 'IN_PROGRESS') {
      this.sendError(ws, 'Cannot declare winner: no active round.');
      return;
    }

    if (state.isPaused) {
      this.sendError(ws, 'The game is currently paused by the host.');
      return;
    }

    const player = state.players[playerId];
    if (!player) {
      this.sendError(ws, 'Player not found in room.');
      return;
    }

    const hand = state.playerHands[playerId] || [];
    const validation = CardEngine.validateWinningHand(hand);

    if (!validation.isValid) {
      // Send invalid claim error to the claimant
      const msg: BaseSocketMessage<'invalid_winner_claim', any> = {
        event: 'invalid_winner_claim',
        roomId: state.roomId,
        payload: {
          playerId,
          reason: validation.reason || "You don't have four matching cards yet!",
        },
      };
      ws.send(JSON.stringify(msg));
      return;
    }

    // Finalize Winner!
    if (this.timerInterval) {
      clearInterval(this.timerInterval);
    }

    state.roomStatus = 'ROUND_COMPLETED';
    player.roundWins += 1;
    player.totalPoints += 10;

    // Prepare all players scoring
    const playerScores = Object.values(state.players).map(p => ({
      playerId: p.id,
      isWinner: p.id === playerId,
      points: p.id === playerId ? 10 : 0,
    }));

    // Record round in D1 database asynchronously
    if (state.matchId) {
      this.ctx.waitUntil(
        this.dbRepo.recordRoundWin(
          state.roomId,
          state.matchId,
          state.currentRound,
          playerId,
          playerScores
        )
      );
    }

    await this.saveRoomState(state);

    const isFinalRound = state.currentRound >= state.totalRounds;

    // Broadcast winner announcement
    this.broadcast('winner_validated', {
      winnerPlayerId: playerId,
      winnerPlayerName: player.name,
      cardName: validation.cardName,
      cardImageUrl: validation.cardImageUrl,
      points: 10,
      matchingCards: hand,
    });

    const leaderboard = this.calculateLeaderboard(state);

    this.broadcast('round_completed', {
      roundNumber: state.currentRound,
      winnerPlayerId: playerId,
      winnerPlayerName: player.name,
      leaderboard,
      isFinalRound,
    });

    if (isFinalRound) {
      state.roomStatus = 'COMPLETED';
      const champion = leaderboard[0];
      await this.saveRoomState(state);

      if (state.matchId) {
        this.ctx.waitUntil(
          this.dbRepo.recordGameCompletion(
            state.matchId,
            champion.playerId,
            leaderboard.map(l => ({
              playerId: l.playerId,
              totalPoints: l.totalPoints,
              isChampion: l.playerId === champion.playerId,
            }))
          )
        );
      }

      this.broadcast('game_completed', {
        championPlayerId: champion.playerId,
        championPlayerName: champion.playerName,
        championAvatar: champion.avatarUrl,
        finalLeaderboard: leaderboard,
      });
    }

    this.broadcastRoomUpdate(state);
  }

  /**
   * Start next round or Play Again
   */
  private async onRequestNextRound(ws: WebSocket, playerId: string, state: StoredRoomState): Promise<void> {
    const player = state.players[playerId];
    if (!player || !player.isHost) {
      this.sendError(ws, 'Only the host can advance to the next round.');
      return;
    }

    if (state.roomStatus === 'COMPLETED') {
      this.broadcast('round_countdown_started', {
        countdownSeconds: 3,
        nextRoundNumber: 1,
      });
      await new Promise(resolve => setTimeout(resolve, 3000));

      // Play Again: reset match and scores
      state.currentRound = 1;
      state.matchId = `match_${state.roomId}_${Date.now()}`;
      Object.values(state.players).forEach(p => {
        p.totalPoints = 0;
        p.roundWins = 0;
      });
      await this.startRound(state);
      this.broadcast('next_round_started', { roundNumber: 1 });
      return;
    }

    if (state.roomStatus === 'ROUND_COMPLETED') {
      const nextRound = state.currentRound + 1;
      this.broadcast('round_countdown_started', {
        countdownSeconds: 3,
        nextRoundNumber: nextRound,
      });
      await new Promise(resolve => setTimeout(resolve, 3000));

      state.currentRound = nextRound;
      await this.startRound(state);
      this.broadcast('next_round_started', { roundNumber: state.currentRound });
    }
  }

  /**
   * Host pauses game
   */
  private async onPauseGame(ws: WebSocket, playerId: string, state: StoredRoomState): Promise<void> {
    const player = state.players[playerId];
    if (!player || !player.isHost) {
      this.sendError(ws, 'Only the host can pause the game.');
      return;
    }

    if (state.roomStatus !== 'IN_PROGRESS') {
      this.sendError(ws, 'Can only pause a game in progress.');
      return;
    }

    state.isPaused = true;
    state.pausedByPlayerName = player.name;
    await this.saveRoomState(state);

    this.broadcast('game_paused', {
      isPaused: true,
      pausedBy: player.name,
    });
    this.broadcastRoomUpdate(state);
  }

  /**
   * Host resumes paused game
   */
  private async onResumeGame(ws: WebSocket, playerId: string, state: StoredRoomState): Promise<void> {
    const player = state.players[playerId];
    if (!player || !player.isHost) {
      this.sendError(ws, 'Only the host can resume the game.');
      return;
    }

    if (!state.isPaused) {
      return;
    }

    state.isPaused = false;
    state.pausedByPlayerName = undefined;
    await this.saveRoomState(state);

    this.broadcast('game_resumed', {
      isPaused: false,
    });
    this.broadcastRoomUpdate(state);
  }

  /**
   * Host ends game completely
   */
  private async onEndGame(ws: WebSocket, playerId: string, state: StoredRoomState): Promise<void> {
    const player = state.players[playerId];
    if (!player || !player.isHost) {
      this.sendError(ws, 'Only the host can end the game.');
      return;
    }

    if (this.timerInterval) {
      clearInterval(this.timerInterval);
      this.timerInterval = undefined as any;
    }

    state.roomStatus = 'COMPLETED';
    const leaderboard = this.calculateLeaderboard(state);
    const champion = leaderboard[0];
    await this.saveRoomState(state);

    if (state.matchId) {
      this.ctx.waitUntil(
        this.dbRepo.recordGameCompletion(
          state.matchId,
          champion.playerId,
          leaderboard.map(l => ({
            playerId: l.playerId,
            totalPoints: l.totalPoints,
            isChampion: l.playerId === champion.playerId,
          }))
        )
      );
    }

    this.broadcast('game_completed', {
      championPlayerId: champion.playerId,
      championPlayerName: champion.playerName,
      championAvatar: champion.avatarUrl,
      finalLeaderboard: leaderboard,
      endedByHost: true,
    });

    this.broadcastRoomUpdate(state);
  }

  /**
   * Leave room
   */
  private async onLeaveRoom(ws: WebSocket, playerId: string, state: StoredRoomState): Promise<void> {
    if (state.roomStatus === 'IN_PROGRESS' || state.roomStatus === 'ROUND_COMPLETED') {
      // In active game: preserve seats and hands so player can rejoin via room code + password
      if (state.players[playerId]) {
        state.players[playerId].isConnected = false;
        state.players[playerId].lastActive = Date.now();
      }
    } else {
      delete state.players[playerId];
      delete state.playerHands[playerId];
      state.turnOrder = state.turnOrder.filter(id => id !== playerId);
      state.submittedCards = state.submittedCards.filter(c => c.playerId !== playerId);
    }

    const activePlayers = Object.values(state.players);
    if (activePlayers.length === 0 || activePlayers.every(p => !p.isConnected && state.roomStatus === 'WAITING')) {
      state.roomStatus = 'CANCELLED';
      if (this.timerInterval) {
        clearInterval(this.timerInterval);
        this.timerInterval = undefined as any;
      }
    } else if (state.hostPlayerId === playerId) {
      // Migrate host to first remaining connected player
      const nextHost = activePlayers.find(p => p.isConnected) || activePlayers[0];
      if (nextHost) {
        nextHost.isHost = true;
        state.hostPlayerId = nextHost.id;
      }
    }

    await this.saveRoomState(state);
    this.broadcast('player_left', { playerId });
    this.broadcastRoomUpdate(state);
  }

  /**
   * Broadcast message to all connected clients in this room
   */
  private broadcast(event: ServerEventType, payload: any): void {
    const msg: BaseSocketMessage<ServerEventType, any> = {
      event,
      roomId: this.stateCache?.roomId || '',
      payload,
    };
    const json = JSON.stringify(msg);

    for (const [ws] of this.sessions.entries()) {
      try {
        ws.send(json);
      } catch {
        // ws might be closed
      }
    }
  }

  /**
   * Send private hands strictly to their authorized owner
   */
  private broadcastPrivateHands(state: StoredRoomState): void {
    const cardImageMap = new Map<string, string>();
    for (const sc of state.submittedCards || []) {
      if (sc.cardImageUrl) cardImageMap.set(sc.cardName, sc.cardImageUrl);
    }

    for (const [ws, session] of this.sessions.entries()) {
      const rawHand = state.playerHands[session.playerId] || [];
      const enrichedHand = rawHand.map(card => ({
        ...card,
        cardImageUrl: card.cardImageUrl || cardImageMap.get(card.cardName),
      }));

      const msg: BaseSocketMessage<'private_hand_updated', any> = {
        event: 'private_hand_updated',
        roomId: state.roomId,
        payload: { cards: enrichedHand },
      };
      try {
        ws.send(JSON.stringify(msg));
      } catch {}
    }
  }

  private sendPrivateState(ws: WebSocket, playerId: string, state: StoredRoomState): void {
    const cardImageMap = new Map<string, string>();
    for (const sc of state.submittedCards || []) {
      if (sc.cardImageUrl) cardImageMap.set(sc.cardName, sc.cardImageUrl);
    }

    const rawHand = state.playerHands[playerId] || [];
    const enrichedHand = rawHand.map(card => ({
      ...card,
      cardImageUrl: card.cardImageUrl || cardImageMap.get(card.cardName),
    }));

    const msg: BaseSocketMessage<'private_hand_updated', any> = {
      event: 'private_hand_updated',
      roomId: state.roomId,
      payload: { cards: enrichedHand },
    };
    try {
      ws.send(JSON.stringify(msg));
    } catch {}
  }

  private broadcastRoomUpdate(state: StoredRoomState): void {
    const publicState = this.buildPublicRoomState(state);
    this.broadcast('room_updated', { room: publicState });
  }

  private sendError(ws: WebSocket, message: string): void {
    const msg: BaseSocketMessage<'error', any> = {
      event: 'error',
      roomId: this.stateCache?.roomId || '',
      payload: { message },
    };
    try {
      ws.send(JSON.stringify(msg));
    } catch {}
  }

  /**
   * Builds the public room state without revealing private card details
   */
  private buildPublicRoomState(state: StoredRoomState): PublicRoomState {
    const players: PublicPlayerInfo[] = Object.values(state.players).map(p => ({
      id: p.id,
      name: p.name,
      avatarUrl: p.avatarUrl,
      isHost: p.isHost,
      isReady: p.isReady,
      isConnected: p.isConnected,
      submittedCardName: p.submittedCardName,
      submittedCardImage: p.submittedCardImage,
      cardCount: (state.playerHands[p.id] || []).length,
      totalPoints: p.totalPoints,
      roundWins: p.roundWins,
      isTurn: state.currentTurnPlayerId === p.id,
    }));

    return {
      roomId: state.roomId,
      roomCode: state.roomCode,
      roomName: state.roomName,
      hostPlayerId: state.hostPlayerId,
      maxPlayers: state.maxPlayers,
      totalRounds: state.totalRounds,
      currentRound: state.currentRound,
      roomVisibility: state.roomVisibility,
      roomStatus: state.roomStatus,
      isPaused: !!state.isPaused,
      pausedByPlayerName: state.pausedByPlayerName,
      currentTurnPlayerId: state.currentTurnPlayerId,
      turnTimeRemaining: state.turnTimeRemaining,
      players,
      turnOrder: state.turnOrder || [],
    };
  }

  private calculateLeaderboard(state: StoredRoomState): LeaderboardEntry[] {
    const sorted = Object.values(state.players).sort((a, b) => {
      if (b.totalPoints !== a.totalPoints) return b.totalPoints - a.totalPoints;
      return b.roundWins - a.roundWins;
    });

    return sorted.map((p, idx) => ({
      rank: idx + 1,
      playerId: p.id,
      playerName: p.name,
      avatarUrl: p.avatarUrl,
      roundWins: p.roundWins,
      totalPoints: p.totalPoints,
      completedRounds: state.currentRound,
      remainingRounds: Math.max(0, state.totalRounds - state.currentRound),
    }));
  }
}
