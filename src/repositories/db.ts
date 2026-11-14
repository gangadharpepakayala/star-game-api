import { PlayerProfile, PublicRoomState, LeaderboardEntry, SubmittedCard } from '../models/types';

export interface Env {
  DB: D1Database;
  GAME_ROOM: DurableObjectNamespace;
  R2_BUCKET?: R2Bucket;
  ENVIRONMENT?: string;
}

export class DatabaseRepository {
  constructor(private db: D1Database) {}

  public async getOrCreatePlayer(playerId: string, name?: string, avatarUrl?: string): Promise<PlayerProfile> {
    const now = new Date().toISOString();
    const existing = await this.db
      .prepare('select * from players where id = ?')
      .bind(playerId)
      .first<any>();

    if (existing) {
      return {
        id: existing.id,
        playerName: existing.playername,
        avatarUrl: existing.avatarurl,
        createdDateTime: existing.createddatetime,
        updatedDateTime: existing.updateddatetime,
        status: existing.status,
      };
    }

    const playerName = name || `Adventurer ${playerId.slice(0, 4)}`;
    const avatar = avatarUrl || `https://api.dicebear.com/7.x/bottts/svg?seed=${playerId}`;

    await this.db
      .prepare(
        'insert into players (id, playername, avatarurl, createdby, createddatetime, updatedby, updateddatetime, status) values (?, ?, ?, ?, ?, ?, ?, ?)'
      )
      .bind(playerId, playerName, avatar, 'SYSTEM', now, 'SYSTEM', now, 'ACTIVE')
      .run();

    // Initialize stats
    await this.db
      .prepare(
        'insert or ignore into playerstats (id, playerid, gamesplayed, gameswon, roundswon, totalpoints, createdby, createddatetime, updatedby, updateddatetime, status) values (?, ?, 0, 0, 0, 0, ?, ?, ?, ?, ?)'
      )
      .bind(`stat_${playerId}`, playerId, 'SYSTEM', now, 'SYSTEM', now, 'ACTIVE')
      .run();

    // Initialize global leaderboard entry
    await this.db
      .prepare(
        'insert or ignore into globalleaderboard (id, playerid, totalgames, totalwins, totalpoints, updateddatetime) values (?, ?, 0, 0, 0, ?)'
      )
      .bind(`glb_${playerId}`, playerId, now)
      .run();

    return {
      id: playerId,
      playerName,
      avatarUrl: avatar,
      createdDateTime: now,
      updatedDateTime: now,
      status: 'ACTIVE',
    };
  }

  public async updatePlayerProfile(playerId: string, playerName: string, avatarUrl?: string): Promise<void> {
    const now = new Date().toISOString();
    await this.db
      .prepare(
        'update players set playername = ?, avatarurl = coalesce(?, avatarurl), updateddatetime = ? where id = ?'
      )
      .bind(playerName, avatarUrl || null, now, playerId)
      .run();
  }

  public async createGameRoom(room: {
    id: string;
    roomCode: string;
    roomName: string;
    hostPlayerId: string;
    maxPlayers: number;
    totalRounds: number;
    roomVisibility: string;
    passwordHash?: string;
  }): Promise<void> {
    const now = new Date().toISOString();
    await this.db
      .prepare(
        `insert into gamerooms (
          id, roomcode, roomname, hostplayerid, maxplayers, totalrounds, 
          currentround, roomvisibility, passwordhash, roomstatus, 
          createdby, createddatetime, updatedby, updateddatetime, status
        ) values (?, ?, ?, ?, ?, ?, 1, ?, ?, 'WAITING', ?, ?, ?, ?, 'ACTIVE')`
      )
      .bind(
        room.id,
        room.roomCode,
        room.roomName,
        room.hostPlayerId,
        room.maxPlayers,
        room.totalRounds,
        room.roomVisibility,
        room.passwordHash || null,
        room.hostPlayerId,
        now,
        room.hostPlayerId,
        now
      )
      .run();
  }

  public async expireRoom(roomId: string): Promise<void> {
    const now = new Date().toISOString();
    await this.db
      .prepare('update gamerooms set roomstatus = ?, updateddatetime = ? where id = ?')
      .bind('EXPIRED', now, roomId)
      .run();
  }

  public async deleteExpiredRooms(): Promise<void> {
    // Delete rooms older than 2 hours
    await this.db
      .prepare(`
        delete from gamerooms 
        where createddatetime < datetime('now', '-2 hours')
      `)
      .run();
  }

  public async getRoomByCode(code: string): Promise<any> {
    const room = await this.db
      .prepare(`
        select * from gamerooms 
        where roomcode = ? and status = ? and createddatetime >= datetime('now', '-2 hours')
      `)
      .bind(code.toUpperCase(), 'ACTIVE')
      .first();

    if (room && (room as any).roomstatus === 'EXPIRED') return null;
    return room;
  }

  public async getRoomById(id: string): Promise<any> {
    const room = await this.db
      .prepare(`
        select * from gamerooms 
        where id = ? and status = ? and createddatetime >= datetime('now', '-2 hours')
      `)
      .bind(id, 'ACTIVE')
      .first();

    if (room && (room as any).roomstatus === 'EXPIRED') return null;
    return room;
  }

  public async getPublicRooms(): Promise<any[]> {
    const result = await this.db
      .prepare(
        `select r.*, count(p.id) as currentplayers 
         from gamerooms r 
         left join roomplayers p on r.id = p.roomid and p.isconnected = 1 
         where r.roomvisibility = 'PUBLIC' 
           and r.roomstatus in ('WAITING', 'STARTING') 
           and r.status = 'ACTIVE' 
           and r.createddatetime >= datetime('now', '-2 hours')
         group by r.id 
         order by r.createddatetime desc limit 20`
      )
      .all();
    return result.results || [];
  }

  public async recordRoundWin(
    roomId: string,
    matchId: string,
    roundNumber: number,
    winnerPlayerId: string,
    allPlayers: { playerId: string; isWinner: boolean; points: number }[]
  ): Promise<void> {
    try {
      const now = new Date().toISOString();
      const roundId = `rnd_${roomId}_${roundNumber}`;

      // 1. Ensure gamematches parent row exists to satisfy FOREIGN KEY (matchid)
      await this.db
        .prepare(
          `insert or ignore into gamematches (
            id, roomid, matchstatus, starteddatetime, createdby, createddatetime, updatedby, updateddatetime, status
          ) values (?, ?, 'IN_PROGRESS', ?, 'SYSTEM', ?, 'SYSTEM', ?, 'ACTIVE')`
        )
        .bind(matchId, roomId, now, now, now)
        .run();

      // 2. Ensure winner & all players exist in players table to satisfy FOREIGN KEY (playerid)
      if (winnerPlayerId) {
        await this.getOrCreatePlayer(winnerPlayerId);
      }
      for (const p of allPlayers) {
        await this.getOrCreatePlayer(p.playerId);
      }

      // 3. Insert round
      await this.db
        .prepare(
          `insert or replace into gamerounds (
            id, matchid, roundnumber, roundstatus, winnerplayerid, 
            starteddatetime, completeddatetime, createdby, createddatetime, updatedby, updateddatetime, status
          ) values (?, ?, ?, 'COMPLETED', ?, ?, ?, 'SYSTEM', ?, 'SYSTEM', ?, 'ACTIVE')`
        )
        .bind(roundId, matchId, roundNumber, winnerPlayerId, now, now, now, now)
        .run();

      // 4. Insert round results and update player stats
      for (const p of allPlayers) {
        const resId = `res_${roundId}_${p.playerId}`;
        await this.db
          .prepare(
            `insert or replace into roundresults (
              id, matchid, roundid, playerid, iswinner, points, winningtime, 
              createdby, createddatetime, updatedby, updateddatetime, status
            ) values (?, ?, ?, ?, ?, ?, ?, 'SYSTEM', ?, 'SYSTEM', ?, 'ACTIVE')`
          )
          .bind(resId, matchId, roundId, p.playerId, p.isWinner ? 1 : 0, p.points, Date.now(), now, now)
          .run();

        // Update player stats
        await this.db
          .prepare(
            `update playerstats set 
              roundswon = roundswon + ?, 
              totalpoints = totalpoints + ?, 
              updateddatetime = ? 
             where playerid = ?`
          )
          .bind(p.isWinner ? 1 : 0, p.points, now, p.playerId)
          .run();
      }
    } catch (err: any) {
      console.error('Failed to record round win to D1:', err?.message || err);
    }
  }

  public async recordGameCompletion(
    matchId: string,
    championPlayerId: string,
    players: { playerId: string; totalPoints: number; isChampion: boolean }[]
  ): Promise<void> {
    try {
      const now = new Date().toISOString();

      // Mark match completed
      await this.db
        .prepare(
          `update gamematches set matchstatus = 'COMPLETED', completeddatetime = ?, updateddatetime = ? where id = ?`
        )
        .bind(now, now, matchId)
        .run();

      for (const p of players) {
        await this.getOrCreatePlayer(p.playerId);

        await this.db
          .prepare(
            `update playerstats set 
              gamesplayed = gamesplayed + 1, 
              gameswon = gameswon + ?, 
              updateddatetime = ? 
             where playerid = ?`
          )
          .bind(p.isChampion ? 1 : 0, now, p.playerId)
          .run();

        await this.db
          .prepare(
            `update globalleaderboard set 
              totalgames = totalgames + 1, 
              totalwins = totalwins + ?, 
              totalpoints = totalpoints + ?, 
              updateddatetime = ? 
             where playerid = ?`
          )
          .bind(p.isChampion ? 1 : 0, p.totalPoints, now, p.playerId)
          .run();
      }
    } catch (err: any) {
      console.error('Failed to record game completion to D1:', err?.message || err);
    }
  }

  public async getGlobalLeaderboard(limit = 50): Promise<LeaderboardEntry[]> {
    const result = await this.db
      .prepare(
        `select g.playerid, p.playername, p.avatarurl, g.totalwins as roundwins, g.totalpoints, g.totalgames 
         from globalleaderboard g 
         join players p on g.playerid = p.id 
         order by g.totalpoints desc, g.totalwins desc 
         limit ?`
      )
      .bind(limit)
      .all<any>();

    return (result.results || []).map((row, index) => ({
      rank: index + 1,
      playerId: row.playerid,
      playerName: row.playername,
      avatarUrl: row.avatarurl || `https://api.dicebear.com/7.x/bottts/svg?seed=${row.playerid}`,
      roundWins: row.roundwins || 0,
      totalPoints: row.totalpoints || 0,
      totalGames: row.totalgames || 0,
    }));
  }

  public async submitPlayerCard(card: {
    id: string;
    roomId: string;
    playerId: string;
    cardName: string;
    cardImageUrl?: string;
  }): Promise<void> {
    const now = new Date().toISOString();
    await this.db
      .prepare(
        `insert into playercards (
          id, roomid, playerid, cardname, cardimageurl,
          createdby, createddatetime, updatedby, updateddatetime, status
        ) values (?, ?, ?, ?, ?, ?, ?, ?, ?, 'ACTIVE')`
      )
      .bind(
        card.id,
        card.roomId,
        card.playerId,
        card.cardName,
        card.cardImageUrl || null,
        card.playerId,
        now,
        card.playerId,
        now
      )
      .run();
  }

  public async getPlayerStats(playerId: string): Promise<any> {
    return await this.db
      .prepare('select * from playerstats where playerid = ?')
      .bind(playerId)
      .first();
  }
}
