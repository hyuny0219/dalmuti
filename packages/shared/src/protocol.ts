import type {
  BotDifficulty,
  Card,
  ChatMessage,
  GameEvent,
  GameOptions,
  GamePublicState,
} from './types';

/** 요청-응답(ack) 공통 포맷 */
export type AckResponse<T = undefined> =
  | { ok: true; data: T }
  | { ok: false; error: { code: string; message: string } };

export type Ack<T = undefined> = (res: AckResponse<T>) => void;

export type RoomPhase = 'LOBBY' | 'IN_GAME';

export type RoomPlayer = {
  id: string;
  nickname: string;
  isBot: boolean;
  botDifficulty: BotDifficulty | null;
  connected: boolean;
  isHost: boolean;
};

export type RoomState = {
  code: string;
  phase: RoomPhase;
  hostId: string;
  players: RoomPlayer[];
  options: GameOptions;
};

/**
 * 제3자에게 브로드캐스트해도 안전한 이벤트.
 * 세금 이벤트의 카드 id(비공개 정보)는 장수로 치환된다.
 */
export type PublicGameEvent =
  | Exclude<GameEvent, { type: 'TAX_TRIBUTE' } | { type: 'TAX_RETURN' }>
  | { type: 'TAX_TRIBUTE'; fromId: string; toId: string; cardCount: number }
  | { type: 'TAX_RETURN'; fromId: string; toId: string; cardCount: number };

export type JoinResult = {
  roomCode: string;
  playerId: string;
  sessionToken: string;
  room: RoomState;
};

/**
 * 재접속 결과. 손패는 여기 포함하지 않는다 —
 * 직후 전송되는 game:hand 이벤트가 손패의 단일 출처(single source of truth).
 */
export type RejoinResult = {
  playerId: string;
  room: RoomState;
  game: GamePublicState | null;
  chatHistory: ChatMessage[];
};

/** 클라이언트 → 서버 이벤트 */
export type ClientToServerEvents = {
  'room:create': (
    payload: { nickname: string; options?: Partial<GameOptions> },
    ack: Ack<JoinResult>,
  ) => void;
  'room:join': (payload: { roomCode: string; nickname: string }, ack: Ack<JoinResult>) => void;
  'room:rejoin': (
    payload: { roomCode: string; sessionToken: string },
    ack: Ack<RejoinResult>,
  ) => void;
  'room:leave': (ack: Ack) => void;
  'room:options': (payload: Partial<GameOptions>, ack: Ack) => void;
  'room:addBot': (payload: { difficulty: BotDifficulty }, ack: Ack) => void;
  'room:removeBot': (payload: { botId: string }, ack: Ack) => void;
  'room:setBotDifficulty': (
    payload: { botId: string; difficulty: BotDifficulty },
    ack: Ack,
  ) => void;
  'room:start': (ack: Ack) => void;
  'game:play': (payload: { cardIds: string[] }, ack: Ack) => void;
  'game:pass': (ack: Ack) => void;
  'game:declareRevolution': (payload: { declare: boolean }, ack: Ack) => void;
  'game:payTax': (payload: { cardIds: string[] }, ack: Ack) => void;
  'game:nextRound': (ack: Ack) => void;
  'chat:send': (payload: { text: string }, ack: Ack) => void;
};

/** 서버 → 클라이언트 이벤트 */
export type ServerToClientEvents = {
  'room:state': (state: RoomState) => void;
  'game:state': (state: GamePublicState) => void;
  /** 본인에게만 전송되는 비공개 정보 */
  'game:hand': (payload: {
    cards: Card[];
    /** 세금 반환 대기 중이면 반환해야 할 장수, 아니면 null */
    pendingTaxReturnCount: number | null;
  }) => void;
  'game:event': (event: PublicGameEvent) => void;
  /**
   * 턴 타이머 상태. deadlineAt(epoch ms)까지 playerId가 행동하지 않으면
   * 서버가 자동 처리(패스/자동 반환/혁명 포기)한다. null이면 타이머 없음.
   */
  'game:timer': (payload: { deadlineAt: number | null; playerId: string | null }) => void;
  'chat:message': (message: ChatMessage) => void;
};

/** 서버 오류 코드 (GameErrorCode 외 서버 계층 오류) */
export type ServerErrorCode =
  | 'ROOM_NOT_FOUND'
  | 'ROOM_FULL'
  | 'ALREADY_IN_ROOM'
  | 'NOT_IN_ROOM'
  | 'NOT_HOST'
  | 'GAME_ALREADY_STARTED'
  | 'GAME_NOT_STARTED'
  | 'INVALID_NICKNAME'
  | 'NICKNAME_TAKEN'
  | 'NOT_A_BOT'
  | 'INVALID_DIFFICULTY'
  | 'INVALID_SESSION'
  | 'INVALID_PAYLOAD'
  | 'CHAT_RATE_LIMITED'
  | 'NOT_ENOUGH_PLAYERS'
  | 'SERVER_FULL';
