export type Card = {
  id: string;
  /** 1(달무티)~12(농노), 13 = 광대(와일드) */
  rank: number;
};

export type SocialRank =
  | 'GREATER_DALMUTI'
  | 'LESSER_DALMUTI'
  | 'MERCHANT'
  | 'LESSER_PEON'
  | 'GREATER_PEON';

export type GamePhase =
  | 'REVOLUTION' // 광대 2장 소유자의 혁명 선언 대기
  | 'TAXATION' // 세금 교환
  | 'PLAYING' // 트릭 진행
  | 'ROUND_END' // 라운드 종료(계급 확정)
  | 'GAME_END';

export type BotDifficulty = 'easy' | 'normal' | 'hard';

export type GameOptions = {
  /** 혁명 규칙 사용 여부 */
  enableRevolution: boolean;
  /** 세금 규칙 사용 여부 */
  enableTaxation: boolean;
  /** 이 라운드 수가 끝나면 게임 종료 */
  targetRounds: number;
  /** 턴 시간 제한(초). null이면 무제한 */
  turnTimeLimitSec: number | null;
};

export const DEFAULT_GAME_OPTIONS: GameOptions = {
  enableRevolution: true,
  enableTaxation: true,
  targetRounds: 5,
  turnTimeLimitSec: 60,
};

/** 필드에 깔린 현재 조합 */
export type FieldState = {
  cards: Card[];
  count: number;
  effectiveRank: number;
  ownerId: string;
};

/** 다른 플레이어에게도 공개되는 플레이어 정보 */
export type PlayerPublic = {
  id: string;
  nickname: string;
  isBot: boolean;
  botDifficulty: BotDifficulty | null;
  connected: boolean;
  handCount: number;
  rank: SocialRank | null;
  /** 이번 라운드에서 손패를 다 턴 순서 (1부터). 아직 못 털었으면 null */
  finishedPlace: number | null;
  score: number;
};

/** 클라이언트로 브로드캐스트되는 공개 게임 상태 */
export type GamePublicState = {
  phase: GamePhase;
  round: number;
  targetRounds: number;
  players: PlayerPublic[]; // 좌석 순서
  currentTurnPlayerId: string | null;
  field: FieldState | null;
  revolution: { declaredById: string | null; isGreat: boolean } | null;
  /** 세금 단계에서 아직 카드를 내야 하는 플레이어 id 목록 */
  taxationPendingIds: string[];
  options: GameOptions;
};

export type ChatMessage = {
  id: string;
  type: 'user' | 'system';
  senderId: string | null;
  senderNickname: string | null;
  text: string;
  timestamp: number;
};

export type GameErrorCode =
  | 'WRONG_PHASE'
  | 'NOT_YOUR_TURN'
  | 'PLAYER_NOT_FOUND'
  | 'CARDS_NOT_IN_HAND'
  | 'INVALID_COMBO'
  | 'CANNOT_BEAT_FIELD'
  | 'LEADER_MUST_PLAY'
  | 'INVALID_PLAYER_COUNT'
  | 'NOT_TAX_PAYER'
  | 'WRONG_TAX_CARDS'
  | 'CANNOT_DECLARE_REVOLUTION';

export class GameError extends Error {
  constructor(
    public readonly code: GameErrorCode,
    message?: string,
  ) {
    super(message ?? code);
    this.name = 'GameError';
  }
}
