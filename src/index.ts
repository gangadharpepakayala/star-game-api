import { Env, DatabaseRepository } from './repositories/db';
import { GameRoom } from './durable-objects/GameRoom';
import { handleApiRequest } from './routes/api';

// Export Durable Object class so Cloudflare Workers runtime binds it
export { GameRoom };

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    return handleApiRequest(request, env);
  },

  // Cloudflare Cron Trigger: cleans up expired rooms older than 2 hours from D1
  async scheduled(controller: ScheduledController, env: Env, ctx: ExecutionContext): Promise<void> {
    const dbRepo = new DatabaseRepository(env.DB);
    ctx.waitUntil(dbRepo.deleteExpiredRooms());
  },
};
