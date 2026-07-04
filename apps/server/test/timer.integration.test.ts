import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { io as clientIo, type Socket } from 'socket.io-client';
import type { AddressInfo } from 'node:net';
import type { AckResponse, GamePublicState, JoinResult } from '@dalmuti/shared';
import { createGameServer, type GameServer } from '../src/server';

let server: GameServer;
let port: number;
let sockets: Socket[] = [];

beforeAll(async () => {
  process.env.BOT_DELAY_MS = '0';
  process.env.RATE_LIMIT_MAX = '100000'; // 드라이버가 사람 이상의 속도로 이벤트를 보낸다
  process.env.ROUND_ADVANCE_MS = '300'; // 라운드 자동 진행을 빠르게
  server = createGameServer();
  await new Promise<void>((resolve) => server.httpServer.listen(0, resolve));
  port = (server.httpServer.address() as AddressInfo).port;
});

afterAll(async () => {
  delete process.env.BOT_DELAY_MS;
  delete process.env.RATE_LIMIT_MAX;
  delete process.env.ROUND_ADVANCE_MS;
  await server.close();
  await new Promise<void>((resolve) => server.httpServer.close(() => resolve()));
});

afterEach(() => {
  for (const s of sockets) s.disconnect();
  sockets = [];
});

async function connect(): Promise<Socket> {
  const socket = clientIo(`http://127.0.0.1:${port}`, {
    transports: ['websocket'],
    forceNew: true,
  });
  sockets.push(socket);
  await new Promise<void>((resolve) => socket.once('connect', () => resolve()));
  return socket;
}

function call<T>(socket: Socket, event: string, ...args: unknown[]): Promise<AckResponse<T>> {
  return new Promise((resolve) => socket.emit(event, ...args, resolve));
}

function expectOk<T>(res: AckResponse<T>): T {
  if (!res.ok) throw new Error(`요청 실패: ${res.error.code} ${res.error.message}`);
  return res.data;
}

describe('턴 타이머와 라운드 자동 진행', () => {
  it('사람이 제한 시간 안에 행동하지 않으면 자동 처리되고 게임이 계속된다', async () => {
    const host = await connect();
    expectOk<JoinResult>(
      await call(host, 'room:create', {
        nickname: '잠수부',
        // 최소 허용치 10초 제한, 2라운드 (자동 진행 검증 포함)
        options: { turnTimeLimitSec: 10, targetRounds: 2 },
      }),
    );
    for (const d of ['normal', 'normal', 'normal'] as const) {
      expectOk(await call(host, 'room:addBot', { difficulty: d }));
    }

    const latest: {
      state: GamePublicState | null;
      timerSeen: boolean;
      autoHandled: boolean;
      myId: string;
    } = { state: null, timerSeen: false, autoHandled: false, myId: '' };
    host.on('game:state', (s: GamePublicState) => {
      latest.state = s;
      latest.myId = s.players.find((p) => !p.isBot)!.id;
    });
    host.on('game:timer', (p: { deadlineAt: number | null }) => {
      if (p.deadlineAt) latest.timerSeen = true;
    });
    host.on('chat:message', (m: { type: string; text: string }) => {
      // 봇들이 0ms로 순식간에 한 바퀴 돌아 다시 내 차례가 되므로,
      // 상태 폴링 대신 자동 처리 시스템 메시지를 진행 신호로 삼는다
      if (m.type === 'system' && m.text.includes('시간이 초과')) {
        latest.autoHandled = true;
      }
    });

    expectOk(await call(host, 'room:start'));

    // 1) 사람 차례가 올 때까지 대기 (봇들은 즉시 행동)
    const waitFor = async (cond: () => boolean, ms: number) => {
      const end = Date.now() + ms;
      while (Date.now() < end && !cond()) {
        await new Promise((r) => setTimeout(r, 200));
      }
      return cond();
    };
    const gotTurn = await waitFor(
      () => latest.state?.currentTurnPlayerId === latest.myId,
      15_000,
    );
    expect(gotTurn).toBe(true);

    // 2) 사람은 아무것도 하지 않는다 → 10초 제한 초과 시 자동 처리된다
    const autoHandled = await waitFor(() => latest.autoHandled, 15_000);
    expect(autoHandled).toBe(true); // 잠수인데도 서버가 대신 처리했다
    expect(latest.timerSeen).toBe(true); // 타이머 이벤트가 브로드캐스트됐다
  }, 45_000);
});
