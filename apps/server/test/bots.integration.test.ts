import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { io as clientIo, type Socket } from 'socket.io-client';
import type { AddressInfo } from 'node:net';
import {
  enumeratePlayableCombos,
  type AckResponse,
  type Card,
  type GamePublicState,
  type JoinResult,
  type RoomState,
} from '@dalmuti/shared';
import { createGameServer, type GameServer } from '../src/server';

let server: GameServer;
let port: number;
let sockets: Socket[] = [];

beforeAll(async () => {
  process.env.BOT_DELAY_MS = '0'; // 봇이 즉시 행동
  server = createGameServer();
  await new Promise<void>((resolve) => server.httpServer.listen(0, resolve));
  port = (server.httpServer.address() as AddressInfo).port;
});

afterAll(async () => {
  delete process.env.BOT_DELAY_MS;
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

describe('봇 관리', () => {
  it('방장이 봇을 추가/난이도 변경/제거할 수 있다', async () => {
    const host = await connect();
    expectOk<JoinResult>(await call(host, 'room:create', { nickname: '단장' }));

    expectOk(await call(host, 'room:addBot', { difficulty: 'easy' }));
    expectOk(await call(host, 'room:addBot', { difficulty: 'hard' }));

    const afterAdd = await new Promise<RoomState>((resolve) => {
      host.once('room:state', resolve);
      void call(host, 'room:addBot', { difficulty: 'normal' });
    });
    expect(afterAdd.players).toHaveLength(4);
    const bots = afterAdd.players.filter((p) => p.isBot);
    expect(bots).toHaveLength(3);
    expect(new Set(bots.map((b) => b.botDifficulty))).toEqual(
      new Set(['easy', 'normal', 'hard']),
    );

    // 난이도 변경
    const target = bots[0]!;
    expectOk(await call(host, 'room:setBotDifficulty', { botId: target.id, difficulty: 'hard' }));

    // 제거
    expectOk(await call(host, 'room:removeBot', { botId: target.id }));

    // 사람은 제거 불가
    const meId = afterAdd.players.find((p) => !p.isBot)!.id;
    const notBot = await call(host, 'room:removeBot', { botId: meId });
    expect(notBot).toMatchObject({ ok: false, error: { code: 'NOT_A_BOT' } });

    // 잘못된 난이도 거부
    const badDiff = await call(host, 'room:addBot', { difficulty: 'impossible' });
    expect(badDiff).toMatchObject({ ok: false, error: { code: 'INVALID_DIFFICULTY' } });
  });

  it('방장이 아니면 봇을 조작할 수 없다', async () => {
    const host = await connect();
    const join = expectOk<JoinResult>(await call(host, 'room:create', { nickname: '단장' }));
    const guest = await connect();
    expectOk(await call(guest, 'room:join', { roomCode: join.roomCode, nickname: '단원' }));

    const res = await call(guest, 'room:addBot', { difficulty: 'easy' });
    expect(res).toMatchObject({ ok: false, error: { code: 'NOT_HOST' } });
  });
});

describe('봇 자동 진행', () => {
  it('사람 1명 + 봇 3명으로 한 라운드가 끝까지 진행된다', async () => {
    const host = await connect();
    expectOk<JoinResult>(
      await call(host, 'room:create', { nickname: '외로운왕', options: { targetRounds: 1 } }),
    );
    for (const d of ['easy', 'normal', 'hard'] as const) {
      expectOk(await call(host, 'room:addBot', { difficulty: d }));
    }

    // 최신 상태/손패 추적 (콜백 할당을 TS가 좁히지 못하도록 객체로 래핑)
    const latest: { state: GamePublicState | null; hand: Card[]; myId: string } = {
      state: null,
      hand: [],
      myId: '',
    };
    host.on('game:state', (s: GamePublicState) => {
      latest.state = s;
      latest.myId = s.players.find((p) => !p.isBot)!.id;
    });
    host.on('game:hand', (p: { cards: Card[] }) => {
      latest.hand = p.cards;
    });

    expectOk(await call(host, 'room:start'));

    // 사람 차례가 오면 첫 유효 수 또는 패스, GAME_END까지 폴링
    const deadline = Date.now() + 20_000;
    while (Date.now() < deadline) {
      const s = latest.state;
      if (s?.phase === 'GAME_END') break;
      if (
        s?.phase === 'PLAYING' &&
        s.currentTurnPlayerId === latest.myId &&
        latest.hand.length > 0
      ) {
        const combos = enumeratePlayableCombos(latest.hand, s.field);
        if (combos.length > 0) {
          await call(host, 'game:play', { cardIds: combos[0]!.map((c) => c.id) });
        } else {
          await call(host, 'game:pass');
        }
      }
      await new Promise((r) => setTimeout(r, 40));
    }

    expect(latest.state?.phase).toBe('GAME_END');
    // 모든 참가자의 완주 순위가 배정됐다
    expect(latest.state!.players.every((p) => p.finishedPlace !== null)).toBe(true);
  }, 30000);
});
