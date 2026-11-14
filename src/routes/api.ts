import { Env, DatabaseRepository } from '../repositories/db';
import { 
  generateId, 
  generateRoomCode, 
  generateSessionToken, 
  parseSessionToken,
  sha256 
} from '../utils/crypto';
import { GameValidators } from '../validators/gameValidators';

export async function handleApiRequest(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  const path = url.pathname;
  const method = request.method;
  const dbRepo = new DatabaseRepository(env.DB);

  // CORS headers
  const corsHeaders = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization, X-Player-Token',
  };

  if (method === 'OPTIONS') {
    return new Response(null, { headers: corsHeaders });
  }

  const jsonResponse = (data: any, status = 200) => {
    return new Response(JSON.stringify(data), {
      status,
      headers: {
        'Content-Type': 'application/json',
        ...corsHeaders,
      },
    });
  };

  const errorResponse = (message: string, status = 400) => {
    return jsonResponse({ error: message }, status);
  };

  // Helper to extract session player
  const getSessionPlayer = (req: Request) => {
    const auth = req.headers.get('Authorization') || req.headers.get('X-Player-Token') || '';
    const token = auth.replace('Bearer ', '').trim();
    if (!token) return null;
    const parsed = parseSessionToken(token);
    if (parsed?.playerId) {
      return { token, playerId: parsed.playerId };
    }
    // Fallback if legacy token format
    const parts = token.split('_');
    const playerId = parts.length >= 3 ? `${parts[1]}_${parts[2]}` : (parts[1] || 'ply');
    return { token, playerId };
  };

  try {
    // 1. PLAYER SESSION: POST /api/players/session
    if (path === '/api/players/session' && method === 'POST') {
      const body = await request.json<any>().catch(() => ({}));
      const playerId = body.playerId || generateId('ply');
      const playerName = body.playerName || `JungleExplorer_${playerId.slice(4, 8)}`;
      const avatarUrl = body.avatarUrl || `https://api.dicebear.com/7.x/bottts/svg?seed=${playerId}`;

      const profile = await dbRepo.getOrCreatePlayer(playerId, playerName, avatarUrl);
      const token = generateSessionToken(playerId);

      return jsonResponse({
        token,
        player: profile,
      });
    }

    // 2. PLAYER PROFILE: GET & PUT /api/players/profile
    if (path === '/api/players/profile') {
      const session = getSessionPlayer(request);
      if (!session) return errorResponse('Unauthorized: missing player session token', 401);

      if (method === 'GET') {
        const profile = await dbRepo.getOrCreatePlayer(session.playerId);
        const stats = await dbRepo.getPlayerStats(session.playerId);
        return jsonResponse({ profile, stats });
      }

      if (method === 'PUT') {
        const body = await request.json<any>();
        const val = GameValidators.validatePlayerName(body.playerName);
        if (!val.valid) return errorResponse(val.error!);

        await dbRepo.updatePlayerProfile(session.playerId, body.playerName, body.avatarUrl);
        const updated = await dbRepo.getOrCreatePlayer(session.playerId);
        return jsonResponse({ profile: updated });
      }
    }

    // 3. CREATE ROOM: POST /api/rooms
    if (path === '/api/rooms' && method === 'POST') {
      const session = getSessionPlayer(request);
      if (!session) return errorResponse('Unauthorized', 401);

      const body = await request.json<any>();
      const roomNameVal = GameValidators.validateRoomName(body.roomName);
      if (!roomNameVal.valid) return errorResponse(roomNameVal.error!);

      const maxPlayersVal = GameValidators.validateMaxPlayers(body.maxPlayers || 4);
      if (!maxPlayersVal.valid) return errorResponse(maxPlayersVal.error!);

      const totalRoundsVal = GameValidators.validateTotalRounds(body.totalRounds || 5);
      if (!totalRoundsVal.valid) return errorResponse(totalRoundsVal.error!);

      if (body.playerName && body.playerName.trim()) {
        const pVal = GameValidators.validatePlayerName(body.playerName);
        if (!pVal.valid) return errorResponse(pVal.error!);
        await dbRepo.updatePlayerProfile(session.playerId, body.playerName.trim());
      }

      let hostCardName: string | undefined = undefined;
      let hostCardImage: string | undefined = undefined;
      if (body.cardName && body.cardName.trim()) {
        const cVal = GameValidators.validateCardName(body.cardName);
        if (!cVal.valid) return errorResponse(cVal.error!);
        hostCardName = body.cardName.trim().toUpperCase();
        hostCardImage = body.cardImageUrl && body.cardImageUrl.length <= 65536 ? body.cardImageUrl : undefined;
      }

      const roomCode = generateRoomCode();
      const roomId = generateId('rm');
      let passwordHash: string | undefined = undefined;

      if (body.roomVisibility === 'PRIVATE' && body.password) {
        passwordHash = await sha256(body.password);
      }

      const player = await dbRepo.getOrCreatePlayer(session.playerId);

      // Save to D1
      await dbRepo.createGameRoom({
        id: roomId,
        roomCode,
        roomName: body.roomName.trim(),
        hostPlayerId: session.playerId,
        maxPlayers: body.maxPlayers || 4,
        totalRounds: body.totalRounds || 5,
        roomVisibility: body.roomVisibility || 'PUBLIC',
        passwordHash,
      });

      if (hostCardName) {
        const cardId = generateId('crd');
        await dbRepo.submitPlayerCard({
          id: cardId,
          roomId,
          playerId: session.playerId,
          cardName: hostCardName,
          cardImageUrl: hostCardImage,
        });
      }

      // Initialize Durable Object
      const doId = env.GAME_ROOM.idFromName(roomId);
      const doStub = env.GAME_ROOM.get(doId);
      const initResp = await doStub.fetch(new Request('http://internal/init', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          roomId,
          roomCode,
          roomName: body.roomName.trim(),
          hostPlayerId: session.playerId,
          hostPlayerName: player.playerName,
          hostAvatarUrl: player.avatarUrl,
          hostCardName,
          hostCardImage,
          maxPlayers: body.maxPlayers || 4,
          totalRounds: body.totalRounds || 5,
          roomVisibility: body.roomVisibility || 'PUBLIC',
          passwordHash,
        }),
      }));

      const roomState = await initResp.json();
      return jsonResponse({ roomId, roomCode, roomState }, 201);
    }

    // 4. JOIN ROOM: POST /api/rooms/join
    if (path === '/api/rooms/join' && method === 'POST') {
      const session = getSessionPlayer(request);
      if (!session) return errorResponse('Unauthorized', 401);

      const body = await request.json<any>();
      const roomCode = (body.roomCode || '').trim().toUpperCase();

      if (!roomCode) return errorResponse('Room code is required.');

      const roomRecord = await dbRepo.getRoomByCode(roomCode);
      if (!roomRecord) return errorResponse('Room not found with provided code.', 404);

      if (roomRecord.roomstatus !== 'WAITING') {
        return errorResponse('Game has already started in this room.', 400);
      }

      // Check password if private
      if (roomRecord.roomvisibility === 'PRIVATE' && roomRecord.passwordhash) {
        if (!body.password) {
          return errorResponse('Password required for private room.', 403);
        }
        const enteredHash = await sha256(body.password);
        if (enteredHash !== roomRecord.passwordhash) {
          return errorResponse('Incorrect room password.', 403);
        }
      }

      const player = await dbRepo.getOrCreatePlayer(session.playerId);

      // Verify DO accepts join
      const doId = env.GAME_ROOM.idFromName(roomRecord.id);
      const doStub = env.GAME_ROOM.get(doId);
      const stateResp = await doStub.fetch(new Request('http://internal/state'));
      const state = await stateResp.json<any>();

      const isAlreadyInRoom = Array.isArray(state.players)
        ? state.players.some((p: any) => p.id === session.playerId)
        : !!state.players?.[session.playerId];

      const currentCount = Array.isArray(state.players)
        ? state.players.length
        : Object.keys(state.players || {}).length;

      const maxAllowed = Number(state.maxPlayers || roomRecord.maxplayers || roomRecord.maxPlayers || 4);

      if (!isAlreadyInRoom && currentCount >= maxAllowed) {
        return errorResponse(`Room is already full (${currentCount}/${maxAllowed} players).`, 400);
      }

      return jsonResponse({
        roomId: roomRecord.id,
        roomCode: roomRecord.roomcode,
        roomName: roomRecord.roomname,
        roomState: state,
      });
    }

    // 5. PUBLIC ROOMS: GET /api/rooms/public
    if (path === '/api/rooms/public' && method === 'GET') {
      const publicRooms = await dbRepo.getPublicRooms();
      return jsonResponse({ rooms: publicRooms });
    }

    // 6. GLOBAL LEADERBOARD: GET /api/leaderboard/global
    if (path === '/api/leaderboard/global' && method === 'GET') {
      const leaderboard = await dbRepo.getGlobalLeaderboard(50);
      return jsonResponse({ leaderboard });
    }

    // 7. ROOM SPECIFIC ROUTES: /api/rooms/:roomId/*
    const roomMatch = path.match(/^\/api\/rooms\/([^/]+)(\/.*)?$/);
    if (roomMatch) {
      const roomId = roomMatch[1];
      const subPath = roomMatch[2] || '';

      // WebSocket Upgrade: GET /api/rooms/:roomId/ws
      if (subPath === '/ws') {
        const doId = env.GAME_ROOM.idFromName(roomId);
        const doStub = env.GAME_ROOM.get(doId);
        return doStub.fetch(request);
      }

      // GET /api/rooms/:roomId/state
      if (subPath === '/state' && method === 'GET') {
        const doId = env.GAME_ROOM.idFromName(roomId);
        const doStub = env.GAME_ROOM.get(doId);
        return doStub.fetch(new Request('http://internal/state'));
      }

      // Card image upload: POST /api/rooms/:roomId/card/upload
      if (subPath === '/card/upload' && method === 'POST') {
        const session = getSessionPlayer(request);
        if (!session) return errorResponse('Unauthorized', 401);

        const body = await request.json<any>();
        const imageData = body.imageData; // Base64 data URL or R2 key

        if (!imageData || !imageData.startsWith('data:image/')) {
          return errorResponse('Invalid image data format. Please provide a valid JPEG, PNG or WebP image.', 400);
        }

        // Return validated image URL
        return jsonResponse({
          success: true,
          imageUrl: imageData,
        });
      }

      // GET /api/rooms/:roomId
      if (!subPath && method === 'GET') {
        const room = await dbRepo.getRoomById(roomId);
        if (!room) return errorResponse('Room not found', 404);
        return jsonResponse({ room });
      }
    }

    return errorResponse(`Endpoint not found: ${method} ${path}`, 404);
  } catch (err: any) {
    return errorResponse(err.message || 'Internal Server Error', 500);
  }
}
