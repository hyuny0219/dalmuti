import type { Server, Socket } from 'socket.io';
import {
  GameError,
  MAX_CHAT_LENGTH,
  MAX_PLAYERS,
  MIN_PLAYERS,
  DalmutiGame,
  createBotStrategy,
  enumeratePlayableCombos,
  type Ack,
  type BotDifficulty,
  type BotView,
  type ChatMessage,
  type ClientToServerEvents,
  type GameEvent,
  type PublicGameEvent,
  type ServerToClientEvents,
} from '@dalmuti/shared';
import {
  createBotMember,
  createMember,
  Room,
  type RoomMember,
  RoomManager,
  sanitizeOptions,
  systemMessage,
  userMessage,
} from './room';

const BOT_DIFFICULTIES: readonly BotDifficulty[] = ['easy', 'normal', 'hard'];
const BOT_DIFFICULTY_LABELS: Record<BotDifficulty, string> = {
  easy: '쉬움',
  normal: '보통',
  hard: '어려움',
};
/** 테스트에서 봇 지연을 없앨 수 있게 env로 오버라이드 (호출 시점에 읽는다) */
function botDelayMs(): number {
  const override = process.env.BOT_DELAY_MS;
  if (override !== undefined && Number.isFinite(Number(override))) {
    return Number(override);
  }
  // 사람처럼 보이는 자연스러운 지연
  return 600 + Math.random() * 900;
}

export type IoServer = Server<ClientToServerEvents, ServerToClientEvents>;
export type IoSocket = Socket<ClientToServerEvents, ServerToClientEvents>;

type SocketData = { roomCode?: string; playerId?: string };

const fail = (code: string, message: string) =>
  ({ ok: false, error: { code, message } }) as const;
const ok = <T>(data: T) => ({ ok: true, data }) as const;

function getCtx(
  socket: IoSocket,
  rooms: RoomManager,
): { room: Room; memberId: string; isSpectator: boolean } | null {
  const data = socket.data as SocketData;
  if (!data.roomCode || !data.playerId) return null;
  const room = rooms.get(data.roomCode);
  if (!room) return null;
  if (room.findById(data.playerId)) {
    return { room, memberId: data.playerId, isSpectator: false };
  }
  if (room.findSpectatorById(data.playerId)) {
    return { room, memberId: data.playerId, isSpectator: true };
  }
  return null;
}

function validNickname(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  // 제어 문자 제거 후 공백 정리
  const cleaned = raw.replace(/[\p{Cc}\p{Cf}]/gu, '').trim();
  if (cleaned.length < 1 || cleaned.length > 20) return null;
  return cleaned;
}

/** 세금 이벤트의 카드 id(비공개)를 장수로 치환 */
function toPublicEvent(e: GameEvent): PublicGameEvent {
  if (e.type === 'TAX_TRIBUTE' || e.type === 'TAX_RETURN') {
    return { type: e.type, fromId: e.fromId, toId: e.toId, cardCount: e.cardIds.length };
  }
  return e;
}

export class GameGateway {
  constructor(
    private readonly io: IoServer,
    private readonly rooms: RoomManager,
  ) {}

  register(socket: IoSocket): void {
    socket.on('room:create', (payload, ack) => this.onCreate(socket, payload, ack));
    socket.on('room:join', (payload, ack) => this.onJoin(socket, payload, ack));
    socket.on('room:list', (ack) => this.onList(ack));
    socket.on('room:spectate', (payload, ack) => this.onSpectate(socket, payload, ack));
    socket.on('room:setPublic', (payload, ack) => this.onSetPublic(socket, payload, ack));
    socket.on('room:rejoin', (payload, ack) => this.onRejoin(socket, payload, ack));
    socket.on('room:leave', (ack) => this.onLeave(socket, ack));
    socket.on('room:options', (payload, ack) => this.onOptions(socket, payload, ack));
    socket.on('room:addBot', (payload, ack) => this.onAddBot(socket, payload, ack));
    socket.on('room:removeBot', (payload, ack) => this.onRemoveBot(socket, payload, ack));
    socket.on('room:setBotDifficulty', (payload, ack) =>
      this.onSetBotDifficulty(socket, payload, ack),
    );
    socket.on('room:start', (ack) => this.onStart(socket, ack));
    socket.on('game:play', (payload, ack) =>
      this.onGameAction(socket, ack, (game, pid) => {
        this.assertCardIds(payload);
        game.play(pid, payload.cardIds);
      }),
    );
    socket.on('game:pass', (ack) =>
      this.onGameAction(socket, ack, (game, pid) => void game.pass(pid)),
    );
    socket.on('game:declareRevolution', (payload, ack) =>
      this.onGameAction(socket, ack, (game, pid) => {
        if (typeof payload?.declare !== 'boolean') {
          throw new GameError('WRONG_PHASE', '잘못된 요청입니다');
        }
        game.declareRevolution(pid, payload.declare);
      }),
    );
    socket.on('game:payTax', (payload, ack) =>
      this.onGameAction(socket, ack, (game, pid) => {
        this.assertCardIds(payload);
        game.payTaxReturn(pid, payload.cardIds);
      }),
    );
    socket.on('game:nextRound', (ack) => this.onNextRound(socket, ack));
    socket.on('chat:send', (payload, ack) => this.onChat(socket, payload, ack));
    socket.on('disconnect', () => this.onDisconnect(socket));
  }

  // ── 방 생성/입장 ─────────────────────────────────────────────

  private onCreate(
    socket: IoSocket,
    payload: { nickname: string; options?: object; isPublic?: boolean },
    ack: Ack<import('@dalmuti/shared').JoinResult>,
  ): void {
    if (typeof ack !== 'function') return;
    if (getCtx(socket, this.rooms)) return ack(fail('ALREADY_IN_ROOM', '이미 방에 있습니다'));
    const nickname = validNickname(payload?.nickname);
    if (!nickname) return ack(fail('INVALID_NICKNAME', '닉네임은 1~20자여야 합니다'));

    const member = createMember(nickname, socket.id);
    const room = this.rooms.create(member, payload?.options);
    if (!room) return ack(fail('SERVER_FULL', '서버에 방이 가득 찼습니다. 잠시 후 다시 시도해주세요'));
    room.isPublic = payload?.isPublic === true;
    this.bind(socket, room.code, member.id);
    this.pushChat(room, systemMessage(`${nickname}님이 방을 만들었습니다.`));
    this.broadcastRoom(room);
    ack(
      ok({
        roomCode: room.code,
        playerId: member.id,
        sessionToken: member.sessionToken,
        room: room.toState(),
      }),
    );
  }

  private onJoin(
    socket: IoSocket,
    payload: { roomCode: string; nickname: string },
    ack: Ack<import('@dalmuti/shared').JoinResult>,
  ): void {
    if (typeof ack !== 'function') return;
    if (getCtx(socket, this.rooms)) return ack(fail('ALREADY_IN_ROOM', '이미 방에 있습니다'));
    const nickname = validNickname(payload?.nickname);
    if (!nickname) return ack(fail('INVALID_NICKNAME', '닉네임은 1~20자여야 합니다'));
    const room =
      typeof payload?.roomCode === 'string' ? this.rooms.get(payload.roomCode) : undefined;
    if (!room) return ack(fail('ROOM_NOT_FOUND', '방을 찾을 수 없습니다'));
    if (room.isInGame) return ack(fail('GAME_ALREADY_STARTED', '게임이 이미 시작됐습니다'));
    if (room.isFull) return ack(fail('ROOM_FULL', '방이 가득 찼습니다'));
    if (room.members.some((m) => m.nickname === nickname)) {
      return ack(fail('NICKNAME_TAKEN', '이미 사용 중인 닉네임입니다'));
    }

    const member = createMember(nickname, socket.id);
    room.members.push(member);
    room.touch();
    this.bind(socket, room.code, member.id);
    this.pushChat(room, systemMessage(`${nickname}님이 입장했습니다.`));
    this.broadcastRoom(room);
    ack(
      ok({
        roomCode: room.code,
        playerId: member.id,
        sessionToken: member.sessionToken,
        room: room.toState(),
      }),
    );
  }

  private onRejoin(
    socket: IoSocket,
    payload: { roomCode: string; sessionToken: string },
    ack: Ack<import('@dalmuti/shared').RejoinResult>,
  ): void {
    if (typeof ack !== 'function') return;
    const room =
      typeof payload?.roomCode === 'string' ? this.rooms.get(payload.roomCode) : undefined;
    if (!room) return ack(fail('ROOM_NOT_FOUND', '방을 찾을 수 없습니다'));
    const member =
      typeof payload?.sessionToken === 'string'
        ? room.findByToken(payload.sessionToken)
        : undefined;
    if (!member || member.isBot) {
      // 봇 좌석은 사람이 차지할 수 없다 (토큰이 유출돼도 방어)
      return ack(fail('INVALID_SESSION', '세션이 유효하지 않습니다'));
    }
    if (getCtx(socket, this.rooms)) {
      return ack(fail('ALREADY_IN_ROOM', '이미 방에 연결되어 있습니다'));
    }

    // 이전 소켓이 살아있으면 끊는다 (중복 접속 방지).
    // 주의: disconnect는 onDisconnect를 동기 재진입시키므로, 그 핸들러가
    // 멤버를 제거하거나 접속 상태를 덮어쓰지 못하도록 바인딩을 먼저 지운다.
    if (member.socketId && member.socketId !== socket.id) {
      const old = this.io.sockets.sockets.get(member.socketId);
      if (old) {
        (old.data as SocketData).roomCode = undefined;
        (old.data as SocketData).playerId = undefined;
        old.leave(room.code);
        old.disconnect(true);
      }
    }
    member.socketId = socket.id;
    member.connected = true;
    room.game?.setConnected(member.id, true);
    room.touch();
    this.bind(socket, room.code, member.id);
    this.pushChat(room, systemMessage(`${member.nickname}님이 다시 접속했습니다.`));
    this.broadcastRoom(room);
    if (room.game) this.broadcastGameState(room);
    ack(
      ok({
        playerId: member.id,
        room: room.toState(),
        game: room.game?.getPublicState() ?? null,
        chatHistory: [...room.chat],
      }),
    );
    // 손패는 ack가 아닌 game:hand 이벤트로만 전달 (단일 출처 유지)
    if (room.game) {
      this.sendHand(room, member.id);
      // 사람이 모두 이탈해 멈춰 있던 봇 진행 재개
      this.scheduleBots(room);
    }
  }

  // ── 공개 방 목록 / 관전 ──────────────────────────────────────

  private onList(ack: Ack<import('@dalmuti/shared').PublicRoomSummary[]>): void {
    if (typeof ack !== 'function') return;
    ack(ok(this.rooms.listPublic()));
  }

  private onSpectate(
    socket: IoSocket,
    payload: { roomCode: string; nickname: string },
    ack: Ack<import('@dalmuti/shared').SpectateResult>,
  ): void {
    if (typeof ack !== 'function') return;
    if (getCtx(socket, this.rooms)) return ack(fail('ALREADY_IN_ROOM', '이미 방에 있습니다'));
    const nickname = validNickname(payload?.nickname);
    if (!nickname) return ack(fail('INVALID_NICKNAME', '닉네임은 1~20자여야 합니다'));
    const room =
      typeof payload?.roomCode === 'string' ? this.rooms.get(payload.roomCode) : undefined;
    if (!room) return ack(fail('ROOM_NOT_FOUND', '방을 찾을 수 없습니다'));

    const spectator = createMember(nickname, socket.id);
    room.spectators.push(spectator);
    room.touch();
    this.bind(socket, room.code, spectator.id);
    this.pushChat(room, systemMessage(`👁 ${nickname}님이 관전을 시작했습니다.`));
    this.broadcastRoom(room);
    ack(
      ok({
        spectatorId: spectator.id,
        room: room.toState(),
        game: room.game?.getPublicState() ?? null,
        chatHistory: [...room.chat],
      }),
    );
  }

  private onSetPublic(socket: IoSocket, payload: { isPublic: boolean }, ack: Ack): void {
    if (typeof ack !== 'function') return;
    const ctx = getCtx(socket, this.rooms);
    if (!ctx) return ack(fail('NOT_IN_ROOM', '방에 있지 않습니다'));
    if (ctx.memberId !== ctx.room.hostId) return ack(fail('NOT_HOST', '방장만 가능합니다'));
    if (typeof payload?.isPublic !== 'boolean') {
      return ack(fail('INVALID_PAYLOAD', '잘못된 요청입니다'));
    }
    ctx.room.isPublic = payload.isPublic;
    ctx.room.touch();
    this.broadcastRoom(ctx.room);
    ack(ok(undefined));
  }

  private onLeave(socket: IoSocket, ack: Ack): void {
    if (typeof ack !== 'function') return;
    const ctx = getCtx(socket, this.rooms);
    if (!ctx) return ack(fail('NOT_IN_ROOM', '방에 있지 않습니다'));
    if (ctx.isSpectator) {
      this.removeSpectator(socket, ctx.room, ctx.memberId);
      return ack(ok(undefined));
    }
    if (ctx.room.isInGame) {
      // 게임 중 이탈은 좌석과 세션을 보존한다 (엔진에서 자리를 뺄 수 없고,
      // 제거하면 세션 토큰이 사라져 복귀도 불가능해 게임이 교착된다)
      this.markDisconnected(socket, ctx.room, ctx.memberId, '자리를 비웠습니다 (재접속 가능)');
    } else {
      this.removeFromRoom(socket, ctx.room, ctx.memberId, '나갔습니다');
    }
    ack(ok(undefined));
  }

  private onDisconnect(socket: IoSocket): void {
    const ctx = getCtx(socket, this.rooms);
    if (!ctx) return;
    if (ctx.isSpectator) {
      this.removeSpectator(socket, ctx.room, ctx.memberId);
      return;
    }
    if (ctx.room.isInGame) {
      // 게임 중엔 자리를 보존하고 재접속을 기다린다
      this.markDisconnected(socket, ctx.room, ctx.memberId, '연결이 끊어졌습니다');
    } else {
      this.removeFromRoom(socket, ctx.room, ctx.memberId, '나갔습니다');
    }
  }

  private markDisconnected(
    socket: IoSocket,
    room: Room,
    memberId: string,
    verb: string,
  ): void {
    const member = room.findById(memberId);
    if (!member) return;
    member.connected = false;
    member.socketId = null;
    room.game?.setConnected(memberId, false);
    // 마지막 사람이 떠났다면 이미 예약된 봇 행동도 즉시 멈춘다
    if (room.members.every((m) => m.isBot || !m.connected) && room.botTimer) {
      clearTimeout(room.botTimer);
      room.botTimer = null;
    }
    socket.leave(room.code);
    (socket.data as SocketData).roomCode = undefined;
    (socket.data as SocketData).playerId = undefined;
    // 방장이 자리를 비우면 접속 중인 멤버에게 승계 (다음 라운드 진행이 막히지 않게)
    room.reassignHostIfNeeded();
    this.pushChat(room, systemMessage(`${member.nickname}님이 ${verb}.`));
    this.broadcastRoom(room);
    this.broadcastGameState(room);
  }

  private removeFromRoom(
    socket: IoSocket,
    room: Room,
    memberId: string,
    verb: string,
  ): void {
    const member = room.findById(memberId);
    room.members = room.members.filter((m) => m.id !== memberId);
    room.forgetChatRate(memberId);
    socket.leave(room.code);
    (socket.data as SocketData).roomCode = undefined;
    (socket.data as SocketData).playerId = undefined;

    if (room.members.length === 0 || room.hasNoHumans) {
      // 봇만 남은 방은 유지할 이유가 없다 — 남은 관전자에게는 종료를 알린다
      this.io.to(room.code).emit('room:closed');
      this.rooms.delete(room.code);
      return;
    }
    room.reassignHostIfNeeded();
    if (member) this.pushChat(room, systemMessage(`${member.nickname}님이 ${verb}.`));
    this.broadcastRoom(room);
  }

  private removeSpectator(socket: IoSocket, room: Room, spectatorId: string): void {
    room.spectators = room.spectators.filter((s) => s.id !== spectatorId);
    room.forgetChatRate(spectatorId);
    socket.leave(room.code);
    (socket.data as SocketData).roomCode = undefined;
    (socket.data as SocketData).playerId = undefined;
    this.broadcastRoom(room);
  }

  // ── 로비 ────────────────────────────────────────────────────

  private onOptions(socket: IoSocket, payload: object, ack: Ack): void {
    if (typeof ack !== 'function') return;
    const ctx = getCtx(socket, this.rooms);
    if (!ctx) return ack(fail('NOT_IN_ROOM', '방에 있지 않습니다'));
    if (ctx.memberId !== ctx.room.hostId) return ack(fail('NOT_HOST', '방장만 가능합니다'));
    if (ctx.room.isInGame) {
      return ack(fail('GAME_ALREADY_STARTED', '게임 중에는 변경할 수 없습니다'));
    }
    ctx.room.options = sanitizeOptions({ ...ctx.room.options, ...payload });
    ctx.room.touch();
    this.broadcastRoom(ctx.room);
    ack(ok(undefined));
  }

  // ── 봇 관리 (방장, 로비 전용) ─────────────────────────────────

  /** 방장+로비 검증 공통 헬퍼. 실패 시 ack까지 처리하고 null 반환 */
  private hostLobbyCtx(
    socket: IoSocket,
    ack: Ack,
  ): { room: Room; memberId: string } | null {
    const ctx = getCtx(socket, this.rooms);
    if (!ctx) {
      ack(fail('NOT_IN_ROOM', '방에 있지 않습니다'));
      return null;
    }
    if (ctx.memberId !== ctx.room.hostId) {
      ack(fail('NOT_HOST', '방장만 가능합니다'));
      return null;
    }
    if (ctx.room.isInGame) {
      ack(fail('GAME_ALREADY_STARTED', '게임 중에는 변경할 수 없습니다'));
      return null;
    }
    return ctx;
  }

  private onAddBot(
    socket: IoSocket,
    payload: { difficulty: BotDifficulty },
    ack: Ack,
  ): void {
    if (typeof ack !== 'function') return;
    const ctx = this.hostLobbyCtx(socket, ack);
    if (!ctx) return;
    const difficulty = payload?.difficulty;
    if (!BOT_DIFFICULTIES.includes(difficulty)) {
      return ack(fail('INVALID_DIFFICULTY', '난이도는 easy/normal/hard 중 하나입니다'));
    }
    if (ctx.room.isFull) return ack(fail('ROOM_FULL', '방이 가득 찼습니다'));

    const bot = createBotMember(difficulty, ctx.room.members.map((m) => m.nickname));
    ctx.room.members.push(bot);
    ctx.room.touch();
    this.pushChat(
      ctx.room,
      systemMessage(`🤖 ${bot.nickname}(${BOT_DIFFICULTY_LABELS[difficulty]}) 봇이 추가되었습니다.`),
    );
    this.broadcastRoom(ctx.room);
    ack(ok(undefined));
  }

  private onRemoveBot(socket: IoSocket, payload: { botId: string }, ack: Ack): void {
    if (typeof ack !== 'function') return;
    const ctx = this.hostLobbyCtx(socket, ack);
    if (!ctx) return;
    const bot = typeof payload?.botId === 'string' ? ctx.room.findById(payload.botId) : undefined;
    if (!bot?.isBot) return ack(fail('NOT_A_BOT', '봇이 아닙니다'));

    ctx.room.members = ctx.room.members.filter((m) => m.id !== bot.id);
    ctx.room.forgetChatRate(bot.id);
    ctx.room.touch();
    this.pushChat(ctx.room, systemMessage(`🤖 ${bot.nickname} 봇이 제거되었습니다.`));
    this.broadcastRoom(ctx.room);
    ack(ok(undefined));
  }

  private onSetBotDifficulty(
    socket: IoSocket,
    payload: { botId: string; difficulty: BotDifficulty },
    ack: Ack,
  ): void {
    if (typeof ack !== 'function') return;
    const ctx = this.hostLobbyCtx(socket, ack);
    if (!ctx) return;
    const bot = typeof payload?.botId === 'string' ? ctx.room.findById(payload.botId) : undefined;
    if (!bot?.isBot) return ack(fail('NOT_A_BOT', '봇이 아닙니다'));
    if (!BOT_DIFFICULTIES.includes(payload?.difficulty)) {
      return ack(fail('INVALID_DIFFICULTY', '난이도는 easy/normal/hard 중 하나입니다'));
    }
    bot.botDifficulty = payload.difficulty;
    ctx.room.touch();
    this.pushChat(
      ctx.room,
      systemMessage(
        `🤖 ${bot.nickname} 난이도가 ${BOT_DIFFICULTY_LABELS[payload.difficulty]}(으)로 변경되었습니다.`,
      ),
    );
    this.broadcastRoom(ctx.room);
    ack(ok(undefined));
  }

  private onStart(socket: IoSocket, ack: Ack): void {
    if (typeof ack !== 'function') return;
    const ctx = getCtx(socket, this.rooms);
    if (!ctx) return ack(fail('NOT_IN_ROOM', '방에 있지 않습니다'));
    const { room, memberId } = ctx;
    if (memberId !== room.hostId) return ack(fail('NOT_HOST', '방장만 시작할 수 있습니다'));
    if (room.isInGame) return ack(fail('GAME_ALREADY_STARTED', '게임이 이미 시작됐습니다'));

    // 재대결(GAME_END 후 재시작) 시, 지난 게임 중 이탈한 채 돌아오지 않은
    // 사람은 명단에서 제외한다 — 그대로 넘기면 새 엔진이 전원을 접속 중으로
    // 취급해 소켓 없는 유령 좌석이 생긴다
    const departed = room.members.filter((m) => !m.isBot && !m.connected);
    if (departed.length > 0) {
      room.members = room.members.filter((m) => m.isBot || m.connected);
      for (const d of departed) {
        room.forgetChatRate(d.id);
        this.pushChat(
          room,
          systemMessage(`${d.nickname}님은 자리를 비워 새 게임에서 제외됩니다.`),
        );
      }
    }

    if (room.members.length < MIN_PLAYERS) {
      return ack(fail('NOT_ENOUGH_PLAYERS', `최소 ${MIN_PLAYERS}명이 필요합니다`));
    }

    try {
      room.game = new DalmutiGame(
        room.members.map((m) => ({
          id: m.id,
          nickname: m.nickname,
          isBot: m.isBot,
          botDifficulty: m.botDifficulty,
        })),
        room.options,
      );
      room.game.startRound();
    } catch (e) {
      room.game = null;
      return ack(this.gameErrorToAck(e));
    }
    room.touch();
    console.log(`[room] ${room.code} 게임 시작 (${room.members.length}명)`);
    this.pushChat(room, systemMessage('게임을 시작합니다!'));
    // 게임 상태를 먼저 보내고 room:state(IN_GAME)를 나중에 —
    // 클라이언트가 IN_GAME 화면을 그릴 때 game:state가 이미 도착해 있도록
    this.pump(room);
    this.broadcastRoom(room);
    ack(ok(undefined));
  }

  private onNextRound(socket: IoSocket, ack: Ack): void {
    if (typeof ack !== 'function') return;
    const ctx = getCtx(socket, this.rooms);
    if (!ctx?.room.game) return ack(fail('GAME_NOT_STARTED', '게임이 시작되지 않았습니다'));
    if (ctx.memberId !== ctx.room.hostId) return ack(fail('NOT_HOST', '방장만 가능합니다'));
    try {
      ctx.room.game.startRound();
    } catch (e) {
      return ack(this.gameErrorToAck(e));
    }
    ctx.room.touch();
    this.pump(ctx.room);
    ack(ok(undefined));
  }

  // ── 게임 액션 공통 처리 ───────────────────────────────────────

  private onGameAction(
    socket: IoSocket,
    ack: Ack,
    action: (game: DalmutiGame, playerId: string) => void,
  ): void {
    if (typeof ack !== 'function') return;
    const ctx = getCtx(socket, this.rooms);
    if (!ctx) return ack(fail('NOT_IN_ROOM', '방에 있지 않습니다'));
    if (ctx.isSpectator) {
      return ack(fail('NOT_A_PLAYER', '관전자는 게임에 참여할 수 없습니다'));
    }
    if (!ctx.room.game) return ack(fail('GAME_NOT_STARTED', '게임이 시작되지 않았습니다'));
    try {
      action(ctx.room.game, ctx.memberId);
    } catch (e) {
      return ack(this.gameErrorToAck(e));
    }
    ctx.room.touch();
    this.pump(ctx.room);
    ack(ok(undefined));
  }

  private assertCardIds(payload: unknown): asserts payload is { cardIds: string[] } {
    const p = payload as { cardIds?: unknown };
    if (
      !p ||
      !Array.isArray(p.cardIds) ||
      p.cardIds.length === 0 ||
      p.cardIds.length > 80 ||
      !p.cardIds.every((id) => typeof id === 'string' && id.length <= 16)
    ) {
      throw new GameError('CARDS_NOT_IN_HAND', '잘못된 카드 선택입니다');
    }
  }

  private gameErrorToAck(e: unknown) {
    if (e instanceof GameError) return fail(e.code, e.message);
    console.error('[game] unexpected error', e);
    return fail('INTERNAL', '서버 오류가 발생했습니다');
  }

  // ── 채팅 ────────────────────────────────────────────────────

  private onChat(socket: IoSocket, payload: { text: string }, ack: Ack): void {
    if (typeof ack !== 'function') return;
    const ctx = getCtx(socket, this.rooms);
    if (!ctx) return ack(fail('NOT_IN_ROOM', '방에 있지 않습니다'));
    // 관전자도 채팅 가능 — 닉네임에 👁 표시로 구분
    const sender = ctx.isSpectator
      ? ctx.room.findSpectatorById(ctx.memberId)
      : ctx.room.findById(ctx.memberId);
    if (!sender) return ack(fail('NOT_IN_ROOM', '방에 있지 않습니다'));
    const member = ctx.isSpectator
      ? { ...sender, nickname: `👁 ${sender.nickname}` }
      : sender;

    const raw = typeof payload?.text === 'string' ? payload.text : '';
    const text = raw.replace(/[\p{Cc}\p{Cf}]/gu, '').trim();
    if (text.length < 1 || text.length > MAX_CHAT_LENGTH) {
      return ack(fail('INVALID_PAYLOAD', `메시지는 1~${MAX_CHAT_LENGTH}자여야 합니다`));
    }
    if (!ctx.room.checkChatRate(ctx.memberId)) {
      return ack(fail('CHAT_RATE_LIMITED', '메시지를 너무 빠르게 보내고 있습니다'));
    }
    this.pushChat(ctx.room, userMessage(member, text));
    ctx.room.touch();
    ack(ok(undefined));
  }

  // ── 브로드캐스트 ─────────────────────────────────────────────

  private bind(socket: IoSocket, roomCode: string, playerId: string): void {
    (socket.data as SocketData).roomCode = roomCode;
    (socket.data as SocketData).playerId = playerId;
    socket.join(roomCode);
  }

  private pushChat(room: Room, message: ChatMessage): void {
    room.addChat(message);
    this.io.to(room.code).emit('chat:message', message);
  }

  private broadcastRoom(room: Room): void {
    this.io.to(room.code).emit('room:state', room.toState());
  }

  private broadcastGameState(room: Room): void {
    if (!room.game) return;
    this.io.to(room.code).emit('game:state', room.game.getPublicState());
  }

  private sendHand(room: Room, memberId: string): void {
    const game = room.game;
    const member = room.findById(memberId);
    if (!game || !member?.socketId) return;
    try {
      this.io.to(member.socketId).emit('game:hand', {
        cards: game.getHandOf(memberId),
        pendingTaxReturnCount: game.getPendingTaxReturn(memberId)?.count ?? null,
      });
    } catch {
      // 게임 종료 후 입장해 엔진에 좌석이 없는 멤버 — 손패가 없으므로 스킵
    }
  }

  /** 엔진 이벤트를 소비해 브로드캐스트 + 시스템 메시지 생성, 상태/손패 동기화 */
  private pump(room: Room): void {
    const game = room.game;
    if (!game) return;

    // 상태 스냅샷을 먼저 보내야 클라이언트가 이벤트/시스템 메시지를 받았을 때
    // 이미 그 결과가 반영된 상태를 들고 있다 (참조 순서 꼬임 방지)
    this.broadcastGameState(room);
    for (const m of room.members) {
      if (m.connected && !m.isBot) this.sendHand(room, m.id);
    }
    for (const event of game.drainEvents()) {
      // hard 봇의 카드 카운팅용 공개 카드 추적
      if (event.type === 'ROUND_STARTED') {
        room.playedRankCounts = {};
      } else if (event.type === 'PLAYED') {
        for (const c of event.cards) {
          room.playedRankCounts[c.rank] = (room.playedRankCounts[c.rank] ?? 0) + 1;
        }
      }
      const publicEvent = toPublicEvent(event);
      this.io.to(room.code).emit('game:event', publicEvent);
      const text = this.eventToSystemText(room, publicEvent);
      if (text) this.pushChat(room, systemMessage(text));
    }
    this.scheduleBots(room);
    this.manageTurnTimer(room);
    this.manageRoundAdvance(room);
  }

  // ── 턴 타이머 / 라운드 자동 진행 ─────────────────────────────

  /** 사람 액터가 제한 시간 안에 행동하지 않으면 자동 처리 (이탈/잠수로 게임이 멈추지 않게) */
  private manageTurnTimer(room: Room): void {
    const clear = (notify: boolean) => {
      if (room.turnTimer) {
        clearTimeout(room.turnTimer);
        room.turnTimer = null;
      }
      room.turnActorId = null;
      if (room.turnDeadlineAt !== null) {
        room.turnDeadlineAt = null;
        if (notify) {
          this.io.to(room.code).emit('game:timer', { deadlineAt: null, playerId: null });
        }
      }
    };

    const game = room.game;
    const limitSec = room.options.turnTimeLimitSec;
    if (!game || !limitSec) return clear(true);
    const actor = this.pendingActor(room);
    if (!actor || actor.isBot) return clear(true);

    // 모든 액션(pump)마다 시계를 새로 감는다
    clear(false);
    room.turnActorId = actor.id;
    room.turnDeadlineAt = Date.now() + limitSec * 1000;
    this.io
      .to(room.code)
      .emit('game:timer', { deadlineAt: room.turnDeadlineAt, playerId: actor.id });
    room.turnTimer = setTimeout(() => {
      room.turnTimer = null;
      this.onTurnTimeout(room, actor.id);
    }, limitSec * 1000);
  }

  private onTurnTimeout(room: Room, actorId: string): void {
    const game = room.game;
    const actor = this.pendingActor(room);
    if (!game || !actor || actor.id !== actorId || actor.isBot) return;
    this.pushChat(
      room,
      systemMessage(`⏰ ${actor.nickname}님의 시간이 초과되어 자동으로 처리합니다.`),
    );
    this.performFallbackAction(room, actor.id);
    this.pump(room);
  }

  /** 라운드가 끝나면 잠시 후 자동으로 다음 라운드 시작 (방장이 없어도 진행) */
  private manageRoundAdvance(room: Room): void {
    const game = room.game;
    if (game?.phase === 'ROUND_END') {
      if (room.roundAdvanceTimer) return;
      const delay = Number(process.env.ROUND_ADVANCE_MS ?? '') || 12_000;
      room.roundAdvanceTimer = setTimeout(() => {
        room.roundAdvanceTimer = null;
        try {
          if (room.game?.phase === 'ROUND_END') {
            room.game.startRound();
            this.pump(room);
          }
        } catch (e) {
          console.error('[round] 자동 진행 실패:', e);
        }
      }, delay);
    } else if (room.roundAdvanceTimer) {
      // 방장이 먼저 진행했거나 게임이 끝남
      clearTimeout(room.roundAdvanceTimer);
      room.roundAdvanceTimer = null;
    }
  }

  /** 시간 초과/봇 오류 공용 폴백: 패스(리드면 첫 유효 수) / 자동 반환 / 혁명 포기 */
  private performFallbackAction(room: Room, actorId: string): void {
    const game = room.game;
    if (!game) return;
    try {
      if (game.phase === 'PLAYING') {
        if (game.field) {
          game.pass(actorId);
        } else {
          const combos = enumeratePlayableCombos(game.getHandOf(actorId), null);
          if (combos[0]) game.play(actorId, combos[0].map((c) => c.id));
        }
      } else if (game.phase === 'TAXATION') {
        const count = game.getPendingTaxReturn(actorId)?.count ?? 1;
        const ids = game.getHandOf(actorId).slice(0, count).map((c) => c.id);
        game.payTaxReturn(actorId, ids);
      } else if (game.phase === 'REVOLUTION') {
        game.declareRevolution(actorId, false);
      }
    } catch (e) {
      console.error('[fallback] 자동 처리 실패 — 게임이 멈출 수 있습니다:', e);
    }
  }

  // ── 봇 실행 ─────────────────────────────────────────────────

  /** 지금 행동해야 할 참가자가 봇이면 잠시 후 실행하도록 예약 */
  private scheduleBots(room: Room): void {
    const game = room.game;
    if (!game || room.botTimer) return;
    // 사람이 아무도 접속해 있지 않으면 봇도 멈춘다 (재접속 시 재개)
    if (room.members.every((m) => m.isBot || !m.connected)) return;
    if (!this.pendingBotActor(room)) return;
    room.botTimer = setTimeout(() => {
      room.botTimer = null;
      try {
        this.runBotAction(room);
      } catch (e) {
        console.error('[bot] 실행 중 오류:', e);
      }
    }, botDelayMs());
  }

  /** 현재 단계에서 행동이 필요한 멤버 (봇/사람 무관) */
  private pendingActor(room: Room): RoomMember | null {
    const game = room.game;
    if (!game) return null;
    const memberOf = (id: string | null | undefined): RoomMember | null =>
      (id ? room.findById(id) : undefined) ?? null;
    switch (game.phase) {
      case 'PLAYING':
        return memberOf(game.currentPlayer?.id);
      case 'REVOLUTION':
        return memberOf(game.getRevolutionCandidateId());
      case 'TAXATION': {
        // 봇 반환이 먼저 처리되도록 봇 우선, 없으면 첫 대기자(사람)
        const pending = game.getPublicState().taxationPendingIds;
        const bot = pending.map(memberOf).find((m) => m?.isBot);
        return bot ?? memberOf(pending[0]);
      }
      default:
        return null; // ROUND_END/GAME_END는 자동 진행 타이머/방장 몫
    }
  }

  private pendingBotActor(room: Room): RoomMember | null {
    const actor = this.pendingActor(room);
    return actor?.isBot ? actor : null;
  }

  private runBotAction(room: Room): void {
    const game = room.game;
    const actor = this.pendingBotActor(room);
    if (!game || !actor) return;
    // 타이머 예약 이후 사람이 모두 떠났을 수 있다 — scheduleBots와 같은 기준으로 재확인
    if (room.members.every((m) => m.isBot || !m.connected)) return;

    const strategy = createBotStrategy(actor.botDifficulty ?? 'normal');
    const pub = game.getPublicState();
    const view: BotView = {
      myId: actor.id,
      myRank: pub.players.find((p) => p.id === actor.id)?.rank ?? null,
      hand: game.getHandOf(actor.id),
      field: pub.field, // 공개 스냅샷의 복사본 — 엔진 내부 참조를 넘기지 않는다
      players: pub.players,
      playedRankCounts: { ...room.playedRankCounts },
    };

    try {
      if (game.phase === 'REVOLUTION') {
        game.declareRevolution(actor.id, strategy.decideRevolution(view));
      } else if (game.phase === 'TAXATION') {
        const count = game.getPendingTaxReturn(actor.id)?.count ?? 1;
        game.payTaxReturn(actor.id, strategy.decideTaxReturn(view, count));
      } else if (game.phase === 'PLAYING') {
        const decision = strategy.decidePlay(view);
        if (decision.type === 'play') game.play(actor.id, decision.cardIds);
        else game.pass(actor.id);
      }
    } catch (e) {
      // 전략 버그로 게임 전체가 멈추지 않도록 모든 단계에 폴백을 둔다.
      // (폴백이 없으면 scheduleBots가 같은 봇을 계속 재시도하며 방이 교착된다)
      console.error(`[bot] ${actor.nickname} 행동 실패, 폴백 시도:`, e);
      this.performFallbackAction(room, actor.id);
    }
    this.pump(room); // pump 끝에서 다음 봇이 다시 예약된다
  }

  private eventToSystemText(room: Room, e: PublicGameEvent): string | null {
    const nick = (id: string) => room.findById(id)?.nickname ?? '???';
    switch (e.type) {
      case 'ROUND_STARTED':
        return `라운드 ${e.round} 시작!`;
      case 'REVOLUTION_PENDING':
        return `${nick(e.playerId)}님이 광대 2장을 손에 넣었습니다. 혁명을 선언할지 결정 중...`;
      case 'REVOLUTION_DECLARED':
        return e.isGreat
          ? `대혁명! ${nick(e.playerId)}님의 선언으로 계급이 완전히 역전됩니다!`
          : `혁명! ${nick(e.playerId)}님의 선언으로 이번 라운드는 세금이 없습니다.`;
      case 'REVOLUTION_DECLINED':
        return `${nick(e.playerId)}님이 혁명을 포기했습니다.`;
      case 'TAX_TRIBUTE':
        return `${nick(e.fromId)}님이 ${nick(e.toId)}님에게 최고 카드 ${e.cardCount}장을 상납했습니다.`;
      case 'TAX_RETURN':
        return `${nick(e.fromId)}님이 ${nick(e.toId)}님에게 ${e.cardCount}장을 돌려주었습니다.`;
      case 'PLAYER_FINISHED':
        return `🎉 ${nick(e.playerId)}님이 ${e.place}등으로 완주했습니다!`;
      case 'ROUND_ENDED':
        return `라운드 ${e.round} 종료! 다음 라운드의 계급이 정해졌습니다.`;
      case 'GAME_ENDED':
        return '게임 종료! 수고하셨습니다.';
      default:
        return null; // PLAYED/PASSED/TRICK_WON은 채팅에 남기지 않는다 (게임 화면에 표시)
    }
  }
}
