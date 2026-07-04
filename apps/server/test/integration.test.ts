import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { io as clientIo, type Socket } from 'socket.io-client';
import type { AddressInfo } from 'node:net';
import type {
  AckResponse,
  Card,
  ChatMessage,
  GamePublicState,
  JoinResult,
  RejoinResult,
  RoomState,
} from '@dalmuti/shared';
import { createGameServer, type GameServer } from '../src/server';

let server: GameServer;
let port: number;
let sockets: Socket[] = [];

beforeAll(async () => {
  process.env.RATE_LIMIT_MAX = '100000'; // 전체 게임을 사람 이상의 속도로 진행한다
  server = createGameServer();
  await new Promise<void>((resolve) => server.httpServer.listen(0, resolve));
  port = (server.httpServer.address() as AddressInfo).port;
});

afterAll(async () => {
  delete process.env.RATE_LIMIT_MAX;
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

function waitFor<T>(socket: Socket, event: string, timeoutMs = 5000): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error(`${event} 이벤트 대기 시간 초과`)),
      timeoutMs,
    );
    socket.once(event, (payload: T) => {
      clearTimeout(timer);
      resolve(payload);
    });
  });
}

function expectOk<T>(res: AckResponse<T>): T {
  if (!res.ok) throw new Error(`요청 실패: ${res.error.code} ${res.error.message}`);
  return res.data;
}

/** 방 생성 + 3명 입장 → [소켓 4개, 조인 결과 4개] */
async function setupRoom(): Promise<{
  clients: Socket[];
  joins: JoinResult[];
}> {
  const host = await connect();
  const hostJoin = expectOk<JoinResult>(
    await call(host, 'room:create', { nickname: '방장' }),
  );
  const clients = [host];
  const joins = [hostJoin];
  for (let i = 1; i <= 3; i++) {
    const c = await connect();
    const j = expectOk<JoinResult>(
      await call(c, 'room:join', { roomCode: hostJoin.roomCode, nickname: `손님${i}` }),
    );
    clients.push(c);
    joins.push(j);
  }
  return { clients, joins };
}

describe('로비', () => {
  it('방 생성/입장/정원/닉네임 검증', async () => {
    const { clients, joins } = await setupRoom();
    expect(joins[0]!.room.players).toHaveLength(1);
    expect(joins[3]!.room.players).toHaveLength(4);
    expect(joins[0]!.room.hostId).toBe(joins[0]!.playerId);

    // 없는 방
    const stranger = await connect();
    const notFound = await call(stranger, 'room:join', {
      roomCode: 'ZZZZZZ',
      nickname: '유령',
    });
    expect(notFound).toMatchObject({ ok: false, error: { code: 'ROOM_NOT_FOUND' } });

    // 중복 닉네임
    const dup = await call(stranger, 'room:join', {
      roomCode: joins[0]!.roomCode,
      nickname: '방장',
    });
    expect(dup).toMatchObject({ ok: false, error: { code: 'NICKNAME_TAKEN' } });

    // 방장이 아닌 사람의 시작 시도
    const notHost = await call(clients[1]!, 'room:start');
    expect(notHost).toMatchObject({ ok: false, error: { code: 'NOT_HOST' } });
  });

  it('4명 미만이면 시작할 수 없다', async () => {
    const host = await connect();
    expectOk(await call(host, 'room:create', { nickname: '혼자' }));
    const res = await call(host, 'room:start');
    expect(res).toMatchObject({ ok: false, error: { code: 'NOT_ENOUGH_PLAYERS' } });
  });
});

describe('게임 진행', () => {
  it('시작하면 모두 상태와 손패를 받고, 현재 차례만 플레이할 수 있다', async () => {
    const { clients, joins } = await setupRoom();

    const statePromises = clients.map((c) => waitFor<GamePublicState>(c, 'game:state'));
    const handPromises = clients.map((c) =>
      waitFor<{ cards: Card[] }>(c, 'game:hand'),
    );
    expectOk(await call(clients[0]!, 'room:start'));

    const states = await Promise.all(statePromises);
    const hands = await Promise.all(handPromises);

    expect(states[0]!.phase).toBe('PLAYING');
    expect(states[0]!.round).toBe(1);
    // 4명 × 20장 = 80장 전부 분배
    expect(hands.map((h) => h.cards.length)).toEqual([20, 20, 20, 20]);
    // 다른 플레이어 손패는 장수만 보인다
    expect(states[0]!.players.every((p) => p.handCount === 20)).toBe(true);

    const turnId = states[0]!.currentTurnPlayerId!;
    const turnIdx = joins.findIndex((j) => j.playerId === turnId);
    const turnClient = clients[turnIdx]!;
    const notTurnClient = clients[(turnIdx + 1) % 4]!;

    // 차례가 아닌 플레이어의 액션 거부
    const wrongTurn = await call(notTurnClient, 'game:pass');
    expect(wrongTurn).toMatchObject({ ok: false, error: { code: 'NOT_YOUR_TURN' } });

    // 리드는 패스 불가
    const leaderPass = await call(turnClient, 'game:pass');
    expect(leaderPass).toMatchObject({ ok: false, error: { code: 'LEADER_MUST_PLAY' } });

    // 리드가 가장 약한 카드 1장을 낸다 (손패는 정렬돼 있어 마지막이 가장 약함)
    const myHand = hands[turnIdx]!.cards;
    const weakest = myHand[myHand.length - 1]!;
    const nextState = waitFor<GamePublicState>(notTurnClient, 'game:state');
    expectOk(await call(turnClient, 'game:play', { cardIds: [weakest.id] }));

    const after = await nextState;
    expect(after.field).toMatchObject({ count: 1, ownerId: turnId });
    expect(after.currentTurnPlayerId).not.toBe(turnId);

    // 손패에 없는 카드 거부
    const cheat = await call(
      clients[joins.findIndex((j) => j.playerId === after.currentTurnPlayerId!)]!,
      'game:play',
      { cardIds: ['fake-card'] },
    );
    expect(cheat).toMatchObject({ ok: false, error: { code: 'CARDS_NOT_IN_HAND' } });
  });
});

describe('채팅', () => {
  it('메시지 브로드캐스트, 길이 제한, 도배 방지', async () => {
    const { clients } = await setupRoom();
    const received = waitFor<ChatMessage>(clients[3]!, 'chat:message');
    expectOk(await call(clients[0]!, 'chat:send', { text: '안녕하세요!' }));
    const msg = await received;
    expect(msg).toMatchObject({ type: 'user', senderNickname: '방장', text: '안녕하세요!' });

    // 빈 메시지 거부
    const empty = await call(clients[0]!, 'chat:send', { text: '   ' });
    expect(empty).toMatchObject({ ok: false, error: { code: 'INVALID_PAYLOAD' } });

    // 초당 2건 초과 시 거부
    await call(clients[1]!, 'chat:send', { text: '1' });
    await call(clients[1]!, 'chat:send', { text: '2' });
    const limited = await call(clients[1]!, 'chat:send', { text: '3' });
    expect(limited).toMatchObject({ ok: false, error: { code: 'CHAT_RATE_LIMITED' } });
  });
});

describe('재접속', () => {
  it('연결이 끊긴 플레이어가 세션 토큰으로 복귀하면 손패와 채팅을 복구한다', async () => {
    const { clients, joins } = await setupRoom();
    expectOk(await call(clients[0]!, 'room:start'));
    await waitFor<GamePublicState>(clients[3]!, 'game:state');

    // 손님3(인덱스 3)의 연결이 끊긴다
    const observerSawDrop = new Promise<void>((resolve) => {
      clients[0]!.on('game:state', (s: GamePublicState) => {
        const p = s.players.find((x) => x.id === joins[3]!.playerId);
        if (p && !p.connected) resolve();
      });
    });
    clients[3]!.disconnect();
    await observerSawDrop;

    // 새 소켓으로 재접속 — 손패는 ack 직후 game:hand 이벤트로 도착
    const fresh = await connect();
    const handPromise = waitFor<{ cards: Card[] }>(fresh, 'game:hand');
    const rejoin = expectOk<RejoinResult>(
      await call(fresh, 'room:rejoin', {
        roomCode: joins[3]!.roomCode,
        sessionToken: joins[3]!.sessionToken,
      }),
    );
    expect(rejoin.playerId).toBe(joins[3]!.playerId);
    expect(rejoin.game?.phase).toBe('PLAYING');
    expect((await handPromise).cards).toHaveLength(20);
    expect(rejoin.chatHistory.length).toBeGreaterThan(0);
    expect(
      rejoin.room.players.find((p) => p.id === joins[3]!.playerId)?.connected,
    ).toBe(true);

    // 잘못된 토큰은 거부
    const bad = await call(fresh, 'room:rejoin', {
      roomCode: joins[3]!.roomCode,
      sessionToken: 'wrong-token',
    });
    // 이미 방에 복귀했으므로 rejoin 자체는 세션 검증에서 걸린다
    expect(bad).toMatchObject({ ok: false, error: { code: 'INVALID_SESSION' } });
  });

  it('게임 중 나가도 자리가 보존되고, 로비에서는 즉시 제거된다', async () => {
    const { clients, joins } = await setupRoom();

    // 로비에서 이탈 → 즉시 제거
    const roomUpdate = waitFor<RoomState>(clients[0]!, 'room:state');
    clients[2]!.disconnect();
    const state = await roomUpdate;
    expect(state.players).toHaveLength(3);
    expect(state.players.some((p) => p.id === joins[2]!.playerId)).toBe(false);
  });

  it('로비에서 이전 소켓이 살아있는 채로 재접속해도 방과 멤버가 유지된다 (재진입 회귀)', async () => {
    const host = await connect();
    const join = expectOk<JoinResult>(
      await call(host, 'room:create', { nickname: '고스트' }),
    );

    // 이전 소켓이 아직 연결된 상태에서 새 소켓으로 재접속 (두 번째 탭 시나리오)
    const fresh = await connect();
    const rejoin = expectOk<RejoinResult>(
      await call(fresh, 'room:rejoin', {
        roomCode: join.roomCode,
        sessionToken: join.sessionToken,
      }),
    );
    expect(rejoin.room.players).toHaveLength(1);
    expect(rejoin.room.players[0]!.connected).toBe(true);

    // 방이 삭제되지 않았고 새 소켓으로 정상 동작한다
    const chat = await call(fresh, 'chat:send', { text: '살아있다' });
    expect(chat.ok).toBe(true);
  });

  it('게임 중 방장이 이탈하면 접속 중인 멤버가 방장을 승계한다', async () => {
    const { clients, joins } = await setupRoom();
    expectOk(await call(clients[0]!, 'room:start'));
    await waitFor<GamePublicState>(clients[1]!, 'game:state');

    const sawNewHost = new Promise<RoomState>((resolve) => {
      clients[1]!.on('room:state', (s: RoomState) => {
        if (s.hostId !== joins[0]!.playerId) resolve(s);
      });
    });
    clients[0]!.disconnect();
    const state = await sawNewHost;
    expect(state.hostId).not.toBe(joins[0]!.playerId);
    expect(state.players.find((p) => p.id === state.hostId)?.connected).toBe(true);
  });

  it('게임 중 room:leave 해도 좌석과 세션이 보존되어 복귀할 수 있다', async () => {
    const { clients, joins } = await setupRoom();
    expectOk(await call(clients[0]!, 'room:start'));
    await waitFor<GamePublicState>(clients[3]!, 'game:state');

    expectOk(await call(clients[3]!, 'room:leave'));

    const fresh = await connect();
    const rejoin = expectOk<RejoinResult>(
      await call(fresh, 'room:rejoin', {
        roomCode: joins[3]!.roomCode,
        sessionToken: joins[3]!.sessionToken,
      }),
    );
    expect(rejoin.game?.phase).toBe('PLAYING');
    expect(rejoin.room.players).toHaveLength(4); // 좌석 보존
  });
});
