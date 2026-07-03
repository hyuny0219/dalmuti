import { createServer, type Server as HttpServer } from 'node:http';
import { Server } from 'socket.io';
import type { ClientToServerEvents, ServerToClientEvents } from '@dalmuti/shared';
import { GameGateway } from './handlers';
import { RoomManager } from './room';

export type GameServer = {
  httpServer: HttpServer;
  io: Server<ClientToServerEvents, ServerToClientEvents>;
  rooms: RoomManager;
  close: () => Promise<void>;
};

export function createGameServer(): GameServer {
  const httpServer = createServer((req, res) => {
    // 로드밸런서/모니터링용 헬스체크
    if (req.url === '/healthz') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: true }));
      return;
    }
    res.writeHead(404);
    res.end();
  });

  const corsOrigin = process.env.CORS_ORIGIN?.split(',').map((s) => s.trim());
  const io = new Server<ClientToServerEvents, ServerToClientEvents>(httpServer, {
    cors: { origin: corsOrigin ?? true },
  });

  const rooms = new RoomManager();
  const gateway = new GameGateway(io, rooms);
  io.on('connection', (socket) => gateway.register(socket));

  const sweeper = setInterval(() => rooms.sweep(), 60_000);
  sweeper.unref();

  const close = async () => {
    clearInterval(sweeper);
    io.disconnectSockets(true);
    await io.close();
  };

  return { httpServer, io, rooms, close };
}
