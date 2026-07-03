import { randomBytes, randomUUID } from 'node:crypto';
import {
  CHAT_HISTORY_LIMIT,
  DalmutiGame,
  DEFAULT_GAME_OPTIONS,
  MAX_PLAYERS,
  type BotDifficulty,
  type ChatMessage,
  type GameOptions,
  type RoomPlayer,
  type RoomState,
} from '@dalmuti/shared';

export type RoomMember = {
  id: string;
  nickname: string;
  sessionToken: string;
  socketId: string | null;
  connected: boolean;
  isBot: boolean;
  botDifficulty: BotDifficulty | null;
};

/** 초당 허용 채팅 수 (도배 방지) */
const CHAT_RATE_PER_SECOND = 2;

export class Room {
  readonly code: string;
  hostId: string;
  options: GameOptions;
  members: RoomMember[] = [];
  game: DalmutiGame | null = null;
  chat: ChatMessage[] = [];
  lastActivityAt = Date.now();
  /** 예약된 봇 행동 타이머 (방 삭제 시 반드시 해제) */
  botTimer: NodeJS.Timeout | null = null;
  /** 이번 라운드에 공개된 카드의 숫자별 장수 (hard 봇 카운팅용) */
  playedRankCounts: Record<number, number> = {};
  private chatTimestamps = new Map<string, number[]>();

  constructor(code: string, host: RoomMember, options: Partial<GameOptions>) {
    this.code = code;
    this.hostId = host.id;
    this.members = [host];
    this.options = sanitizeOptions(options);
  }

  touch(): void {
    this.lastActivityAt = Date.now();
  }

  get isFull(): boolean {
    return this.members.length >= MAX_PLAYERS;
  }

  get isInGame(): boolean {
    return this.game !== null && this.game.phase !== 'GAME_END';
  }

  findByToken(sessionToken: string): RoomMember | undefined {
    return this.members.find((m) => m.sessionToken === sessionToken);
  }

  findById(playerId: string): RoomMember | undefined {
    return this.members.find((m) => m.id === playerId);
  }

  /**
   * 방장 승계: 방장이 없거나 접속이 끊겼으면 접속 중인 사람 멤버에게 넘긴다.
   * (게임 중 방장이 이탈해도 다음 라운드 진행이 막히지 않도록. 봇은 방장 불가)
   * 아무도 접속해 있지 않으면 방장을 유지해 복귀 시 그대로 방장이 된다.
   */
  reassignHostIfNeeded(): void {
    const host = this.members.find((m) => m.id === this.hostId);
    if (host?.connected && !host.isBot) return;
    const next = this.members.find((m) => m.connected && !m.isBot);
    if (next) {
      this.hostId = next.id;
    } else if (!host) {
      const human = this.members.find((m) => !m.isBot);
      if (human) this.hostId = human.id;
    }
  }

  /** 사람 멤버가 한 명도 없는가 (봇만 남은 방은 유지할 이유가 없다) */
  get hasNoHumans(): boolean {
    return this.members.every((m) => m.isBot);
  }

  dispose(): void {
    if (this.botTimer) {
      clearTimeout(this.botTimer);
      this.botTimer = null;
    }
  }

  /** 떠난 멤버의 레이트리밋 기록 정리 (장수명 방의 메모리 누수 방지) */
  forgetChatRate(playerId: string): void {
    this.chatTimestamps.delete(playerId);
  }

  addChat(message: ChatMessage): void {
    this.chat.push(message);
    if (this.chat.length > CHAT_HISTORY_LIMIT) {
      this.chat = this.chat.slice(-CHAT_HISTORY_LIMIT);
    }
  }

  /** true면 허용, false면 도배로 거부 */
  checkChatRate(playerId: string, now = Date.now()): boolean {
    const stamps = (this.chatTimestamps.get(playerId) ?? []).filter(
      (t) => now - t < 1000,
    );
    if (stamps.length >= CHAT_RATE_PER_SECOND) {
      this.chatTimestamps.set(playerId, stamps);
      return false;
    }
    stamps.push(now);
    this.chatTimestamps.set(playerId, stamps);
    return true;
  }

  toState(): RoomState {
    return {
      code: this.code,
      phase: this.game ? 'IN_GAME' : 'LOBBY',
      hostId: this.hostId,
      players: this.members.map(
        (m): RoomPlayer => ({
          id: m.id,
          nickname: m.nickname,
          isBot: m.isBot,
          botDifficulty: m.botDifficulty,
          connected: m.connected,
          isHost: m.id === this.hostId,
        }),
      ),
      options: { ...this.options },
    };
  }
}

export function createMember(nickname: string, socketId: string): RoomMember {
  return {
    id: randomUUID(),
    nickname,
    sessionToken: randomBytes(24).toString('base64url'),
    socketId,
    connected: true,
    isBot: false,
    botDifficulty: null,
  };
}

const BOT_NAME_POOL = [
  '봇-광대', '봇-기사', '봇-석공', '봇-요리사', '봇-광부', '봇-양치기', '봇-재봉사',
];

export function createBotMember(
  difficulty: BotDifficulty,
  takenNicknames: readonly string[],
): RoomMember {
  const base =
    BOT_NAME_POOL.find((n) => !takenNicknames.includes(n)) ??
    `봇-${Math.floor(Math.random() * 1000)}`;
  return {
    id: randomUUID(),
    nickname: base,
    sessionToken: randomBytes(24).toString('base64url'), // 사용되지 않지만 형태 유지
    socketId: null,
    connected: true,
    isBot: true,
    botDifficulty: difficulty,
  };
}

export function systemMessage(text: string): ChatMessage {
  return {
    id: randomUUID(),
    type: 'system',
    senderId: null,
    senderNickname: null,
    text,
    timestamp: Date.now(),
  };
}

export function userMessage(member: RoomMember, text: string): ChatMessage {
  return {
    id: randomUUID(),
    type: 'user',
    senderId: member.id,
    senderNickname: member.nickname,
    text,
    timestamp: Date.now(),
  };
}

/** 방 옵션 검증: 타입/범위를 벗어나면 기본값으로 강제 */
export function sanitizeOptions(input: Partial<GameOptions> | undefined): GameOptions {
  const base = { ...DEFAULT_GAME_OPTIONS };
  if (!input || typeof input !== 'object') return base;
  if (typeof input.enableRevolution === 'boolean') {
    base.enableRevolution = input.enableRevolution;
  }
  if (typeof input.enableTaxation === 'boolean') {
    base.enableTaxation = input.enableTaxation;
  }
  if (
    typeof input.targetRounds === 'number' &&
    Number.isInteger(input.targetRounds) &&
    input.targetRounds >= 1 &&
    input.targetRounds <= 20
  ) {
    base.targetRounds = input.targetRounds;
  }
  if (input.turnTimeLimitSec === null) {
    base.turnTimeLimitSec = null;
  } else if (
    typeof input.turnTimeLimitSec === 'number' &&
    Number.isInteger(input.turnTimeLimitSec) &&
    input.turnTimeLimitSec >= 10 &&
    input.turnTimeLimitSec <= 300
  ) {
    base.turnTimeLimitSec = input.turnTimeLimitSec;
  }
  return base;
}

const ROOM_CODE_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

/** 서버 전체 동시 방 수 상한 (무제한 방 생성 DoS 방지) */
export const MAX_ROOMS = 500;

export class RoomManager {
  private rooms = new Map<string, Room>();

  /** 상한 초과 시 null (호출부에서 SERVER_FULL 응답) */
  create(host: RoomMember, options: Partial<GameOptions> | undefined): Room | null {
    if (this.rooms.size >= MAX_ROOMS) return null;
    let code: string;
    do {
      code = Array.from(
        { length: 6 },
        () => ROOM_CODE_CHARS[Math.floor(Math.random() * ROOM_CODE_CHARS.length)],
      ).join('');
    } while (this.rooms.has(code));
    const room = new Room(code, host, options ?? {});
    this.rooms.set(code, room);
    console.log(`[room] 생성 ${code} (전체 ${this.rooms.size}개)`);
    return room;
  }

  get(code: string): Room | undefined {
    return typeof code === 'string' ? this.rooms.get(code.toUpperCase()) : undefined;
  }

  delete(code: string): void {
    const room = this.rooms.get(code);
    if (room) {
      room.dispose();
      this.rooms.delete(code);
      console.log(`[room] 삭제 ${code} (전체 ${this.rooms.size}개)`);
    }
  }

  get size(): number {
    return this.rooms.size;
  }

  /** 전원이 나갔거나 30분 이상 방치된 방 정리 (봇만 남은 방은 사람이 없는 것으로 취급) */
  sweep(now = Date.now()): number {
    const STALE_MS = 30 * 60 * 1000;
    let removed = 0;
    for (const [code, room] of this.rooms) {
      const empty = room.members.length === 0;
      const noHumanConnected = room.members.every((m) => m.isBot || !m.connected);
      if (empty || (noHumanConnected && now - room.lastActivityAt > STALE_MS)) {
        room.dispose();
        this.rooms.delete(code);
        removed++;
      }
    }
    return removed;
  }
}
