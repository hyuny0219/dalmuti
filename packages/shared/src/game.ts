import { JESTER_RANK, MAX_PLAYERS, MIN_PLAYERS } from './constants';
import { createDeck, deal, shuffle, sortHand } from './deck';
import { analyzeCombo, canBeat, pickCardsFromHand } from './rules';
import {
  type BotDifficulty,
  type Card,
  type FieldState,
  GameError,
  type GameOptions,
  type GamePhase,
  type GamePublicState,
  type PlayerPublic,
  type SocialRank,
} from './types';

export type EnginePlayerInit = {
  id: string;
  nickname: string;
  isBot?: boolean;
  botDifficulty?: BotDifficulty | null;
};

export type EnginePlayer = {
  id: string;
  nickname: string;
  isBot: boolean;
  botDifficulty: BotDifficulty | null;
  connected: boolean;
  hand: Card[];
  rank: SocialRank | null;
  finishedPlace: number | null;
  score: number;
};

/** 세금 단계에서 달무티 측이 되돌려줄 카드 선택 대기 */
type PendingTaxReturn = {
  fromId: string;
  toId: string;
  count: number;
};

export type PlayResult = {
  playerFinished: boolean;
  roundEnded: boolean;
  gameEnded: boolean;
};

export type PassResult = {
  /** 전원 패스로 트릭이 끝나 새 리드를 얻은 플레이어 id */
  trickWonBy: string | null;
};

/**
 * 달무티 게임 엔진.
 * 순수 인메모리 상태 머신 — I/O, 타이머, 소켓을 전혀 모른다.
 * 모든 상태 변경은 메서드를 통해서만 일어나고 잘못된 요청은 GameError를 던진다.
 */
export class DalmutiGame {
  readonly options: GameOptions;
  phase: GamePhase = 'PLAYING';
  round = 0;
  players: EnginePlayer[] = [];
  turnIndex: number | null = null;
  field: FieldState | null = null;
  revolution: { declaredById: string | null; isGreat: boolean } | null = null;
  private finishedCounter = 0;
  private pendingTaxReturns: PendingTaxReturn[] = [];
  private revolutionCandidateId: string | null = null;
  private readonly rng: () => number;
  private readonly deckFactory: (() => Card[]) | null;

  constructor(
    players: EnginePlayerInit[],
    options: GameOptions,
    rng: () => number = Math.random,
    /** 테스트용: 셔플 대신 지정된 덱을 사용 (deal이 좌석 순서대로 한 장씩 분배) */
    deckFactory?: () => Card[],
  ) {
    if (players.length < MIN_PLAYERS || players.length > MAX_PLAYERS) {
      throw new GameError(
        'INVALID_PLAYER_COUNT',
        `플레이어는 ${MIN_PLAYERS}~${MAX_PLAYERS}명이어야 합니다`,
      );
    }
    const ids = new Set(players.map((p) => p.id));
    if (ids.size !== players.length) {
      throw new GameError('INVALID_PLAYER_COUNT', '플레이어 id가 중복됩니다');
    }
    this.options = { ...options };
    this.rng = rng;
    this.deckFactory = deckFactory ?? null;
    this.players = players.map((p) => ({
      id: p.id,
      nickname: p.nickname,
      isBot: p.isBot ?? false,
      botDifficulty: p.botDifficulty ?? null,
      connected: true,
      hand: [],
      rank: null,
      finishedPlace: null,
      score: 0,
    }));
  }

  // ── 라운드 시작 ──────────────────────────────────────────────

  /** 새 라운드 시작: 좌석 재배치(계급순) → 분배 → 혁명/세금/플레이 단계 진입 */
  startRound(): void {
    if (this.phase === 'GAME_END') throw new GameError('WRONG_PHASE');
    this.round += 1;

    // 이전 라운드 계급 순(=완주 순)으로 좌석 재배치
    if (this.round > 1) {
      this.players.sort(
        (a, b) => (a.finishedPlace ?? 99) - (b.finishedPlace ?? 99),
      );
    }

    const deck = this.deckFactory ? this.deckFactory() : shuffle(createDeck(), this.rng);
    const hands = deal(deck, this.players.length);
    this.players.forEach((p, i) => {
      p.hand = sortHand(hands[i]!);
      p.finishedPlace = null;
    });
    this.finishedCounter = 0;
    this.field = null;
    this.revolution = null;
    this.pendingTaxReturns = [];
    this.revolutionCandidateId = null;

    // 첫 라운드는 계급이 없으므로 혁명/세금 없이 무작위 리드로 시작
    if (this.round === 1) {
      this.phase = 'PLAYING';
      this.turnIndex = Math.floor(this.rng() * this.players.length);
      return;
    }

    // 혁명: 광대 2장을 모두 가진 플레이어가 있으면 선언 기회를 준다
    if (this.options.enableRevolution) {
      const holder = this.players.find(
        (p) => p.hand.filter((c) => c.rank === JESTER_RANK).length === 2,
      );
      if (holder) {
        this.revolutionCandidateId = holder.id;
        this.phase = 'REVOLUTION';
        this.turnIndex = null;
        return;
      }
    }
    this.enterTaxationOrPlay();
  }

  private enterTaxationOrPlay(): void {
    if (this.options.enableTaxation && !this.revolution?.declaredById) {
      this.startTaxation();
      if (this.pendingTaxReturns.length > 0) return;
    }
    this.startPlaying();
  }

  /** 농노 → 달무티 상납은 자동(최고 카드 강제), 달무티의 반환 선택만 대기 */
  private startTaxation(): void {
    const byRank = (r: SocialRank) => this.players.find((p) => p.rank === r);
    const exchanges: Array<{ peon?: EnginePlayer; dalmuti?: EnginePlayer; n: number }> = [
      { peon: byRank('GREATER_PEON'), dalmuti: byRank('GREATER_DALMUTI'), n: 2 },
      { peon: byRank('LESSER_PEON'), dalmuti: byRank('LESSER_DALMUTI'), n: 1 },
    ];
    this.phase = 'TAXATION';
    this.turnIndex = null;
    for (const { peon, dalmuti, n } of exchanges) {
      if (!peon || !dalmuti) continue;
      // 최고 카드 = 숫자가 가장 낮은 카드 (광대 13은 절대 상납되지 않음)
      const best = sortHand(peon.hand).slice(0, n);
      peon.hand = peon.hand.filter((c) => !best.some((b) => b.id === c.id));
      dalmuti.hand = sortHand([...dalmuti.hand, ...best]);
      this.pendingTaxReturns.push({ fromId: dalmuti.id, toId: peon.id, count: n });
    }
  }

  private startPlaying(): void {
    this.phase = 'PLAYING';
    // 리드: 대달무티(혁명으로 바뀌었을 수 있음), 없으면 좌석 0
    const leader =
      this.players.findIndex((p) => p.rank === 'GREATER_DALMUTI');
    this.turnIndex = leader >= 0 ? leader : 0;
  }

  // ── 혁명 ────────────────────────────────────────────────────

  declareRevolution(playerId: string, declare: boolean): void {
    if (this.phase !== 'REVOLUTION') throw new GameError('WRONG_PHASE');
    if (playerId !== this.revolutionCandidateId) {
      throw new GameError('CANNOT_DECLARE_REVOLUTION', '광대 2장을 가진 플레이어만 선언할 수 있습니다');
    }
    if (declare) {
      const declarer = this.requirePlayer(playerId);
      const isGreat = declarer.rank === 'GREATER_PEON';
      this.revolution = { declaredById: playerId, isGreat };
      if (isGreat) {
        // 대혁명: 계급 완전 역전 (상인은 유지)
        const mirror: Partial<Record<SocialRank, SocialRank>> = {
          GREATER_DALMUTI: 'GREATER_PEON',
          LESSER_DALMUTI: 'LESSER_PEON',
          LESSER_PEON: 'LESSER_DALMUTI',
          GREATER_PEON: 'GREATER_DALMUTI',
        };
        for (const p of this.players) {
          if (p.rank && mirror[p.rank]) p.rank = mirror[p.rank]!;
        }
        // 새 계급 순으로 좌석 재배치
        const order: SocialRank[] = [
          'GREATER_DALMUTI', 'LESSER_DALMUTI', 'MERCHANT', 'LESSER_PEON', 'GREATER_PEON',
        ];
        this.players.sort((a, b) => order.indexOf(a.rank!) - order.indexOf(b.rank!));
      }
      // 혁명이 선언되면 이번 라운드 세금 면제
      this.startPlaying();
    } else {
      this.enterTaxationOrPlay();
    }
  }

  // ── 세금 ────────────────────────────────────────────────────

  /** 달무티가 농노에게 되돌려줄 카드를 선택 */
  payTaxReturn(playerId: string, cardIds: string[]): void {
    if (this.phase !== 'TAXATION') throw new GameError('WRONG_PHASE');
    const pending = this.pendingTaxReturns.find((t) => t.fromId === playerId);
    if (!pending) throw new GameError('NOT_TAX_PAYER', '반환할 세금이 없습니다');
    if (cardIds.length !== pending.count) {
      throw new GameError('WRONG_TAX_CARDS', `${pending.count}장을 선택해야 합니다`);
    }
    const giver = this.requirePlayer(playerId);
    const cards = pickCardsFromHand(giver.hand, cardIds);
    if (!cards) throw new GameError('CARDS_NOT_IN_HAND');

    const receiver = this.requirePlayer(pending.toId);
    giver.hand = giver.hand.filter((c) => !cardIds.includes(c.id));
    receiver.hand = sortHand([...receiver.hand, ...cards]);
    this.pendingTaxReturns = this.pendingTaxReturns.filter((t) => t !== pending);

    if (this.pendingTaxReturns.length === 0) this.startPlaying();
  }

  // ── 트릭 플레이 ──────────────────────────────────────────────

  play(playerId: string, cardIds: string[]): PlayResult {
    this.assertTurn(playerId);
    const player = this.requirePlayer(playerId);
    const cards = pickCardsFromHand(player.hand, cardIds);
    if (!cards) throw new GameError('CARDS_NOT_IN_HAND');

    const combo = analyzeCombo(cards);
    if (!combo) throw new GameError('INVALID_COMBO', '같은 숫자(+광대)만 함께 낼 수 있습니다');
    if (this.field && !canBeat(this.field, combo)) {
      throw new GameError(
        'CANNOT_BEAT_FIELD',
        `${this.field.count}장, ${this.field.effectiveRank}보다 낮은 숫자만 낼 수 있습니다`,
      );
    }

    player.hand = player.hand.filter((c) => !cardIds.includes(c.id));
    this.field = {
      cards: combo.cards,
      count: combo.count,
      effectiveRank: combo.effectiveRank,
      ownerId: playerId,
    };

    let playerFinished = false;
    if (player.hand.length === 0) {
      playerFinished = true;
      this.finishedCounter += 1;
      player.finishedPlace = this.finishedCounter;
    }

    const remaining = this.players.filter((p) => p.hand.length > 0);
    if (remaining.length <= 1) {
      return { playerFinished, ...this.endRound(remaining[0]) };
    }

    this.advanceTurn();
    return { playerFinished, roundEnded: false, gameEnded: false };
  }

  pass(playerId: string): PassResult {
    this.assertTurn(playerId);
    if (!this.field) {
      throw new GameError('LEADER_MUST_PLAY', '리드 플레이어는 패스할 수 없습니다');
    }
    this.advanceTurn();
    // advanceTurn이 트릭을 끝냈다면 field가 비워져 있다
    return { trickWonBy: this.field === null ? this.currentPlayer!.id : null };
  }

  /**
   * 다음 차례 계산. 필드 주인 좌석에 도달하면 트릭 종료:
   * 주인이 리드를 얻거나, 주인이 이미 완주했으면 다음 미완주자가 리드.
   */
  private advanceTurn(): void {
    const n = this.players.length;
    for (let k = 1; k <= n; k++) {
      const idx = (this.turnIndex! + k) % n;
      const p = this.players[idx]!;
      if (this.field && p.id === this.field.ownerId) {
        this.field = null;
        this.turnIndex = p.hand.length > 0 ? idx : this.nextActiveIndexAfter(idx);
        return;
      }
      if (p.hand.length > 0) {
        this.turnIndex = idx;
        return;
      }
    }
    // 여기 도달 = 남은 플레이어가 없다는 뜻인데, play()에서 라운드 종료를
    // 먼저 처리하므로 정상 흐름에선 불가능
    throw new GameError('WRONG_PHASE', '진행 가능한 플레이어가 없습니다');
  }

  private nextActiveIndexAfter(idx: number): number {
    const n = this.players.length;
    for (let k = 1; k <= n; k++) {
      const i = (idx + k) % n;
      if (this.players[i]!.hand.length > 0) return i;
    }
    throw new GameError('WRONG_PHASE', '진행 가능한 플레이어가 없습니다');
  }

  // ── 라운드/게임 종료 ─────────────────────────────────────────

  private endRound(lastPlayer: EnginePlayer | undefined): {
    roundEnded: true;
    gameEnded: boolean;
  } {
    if (lastPlayer) {
      this.finishedCounter += 1;
      lastPlayer.finishedPlace = this.finishedCounter;
      lastPlayer.hand = [];
    }
    const n = this.players.length;
    for (const p of this.players) {
      p.rank = rankForPlace(p.finishedPlace!, n);
      p.score += n - p.finishedPlace!;
    }
    this.field = null;
    this.turnIndex = null;
    const gameEnded = this.round >= this.options.targetRounds;
    this.phase = gameEnded ? 'GAME_END' : 'ROUND_END';
    return { roundEnded: true, gameEnded };
  }

  // ── 조회 ────────────────────────────────────────────────────

  get currentPlayer(): EnginePlayer | null {
    return this.turnIndex === null ? null : this.players[this.turnIndex]!;
  }

  getHandOf(playerId: string): Card[] {
    return [...this.requirePlayer(playerId).hand];
  }

  /** 세금 반환 대기 중, 해당 플레이어가 받은 상납 내용(공개하면 안 되므로 본인 전용) */
  getPendingTaxReturn(playerId: string): { count: number } | null {
    const t = this.pendingTaxReturns.find((x) => x.fromId === playerId);
    return t ? { count: t.count } : null;
  }

  getRevolutionCandidateId(): string | null {
    return this.phase === 'REVOLUTION' ? this.revolutionCandidateId : null;
  }

  getPublicState(): GamePublicState {
    return {
      phase: this.phase,
      round: this.round,
      targetRounds: this.options.targetRounds,
      players: this.players.map((p): PlayerPublic => ({
        id: p.id,
        nickname: p.nickname,
        isBot: p.isBot,
        botDifficulty: p.botDifficulty,
        connected: p.connected,
        handCount: p.hand.length,
        rank: p.rank,
        finishedPlace: p.finishedPlace,
        score: p.score,
      })),
      currentTurnPlayerId: this.currentPlayer?.id ?? null,
      field: this.field ? { ...this.field, cards: [...this.field.cards] } : null,
      revolution: this.revolution,
      taxationPendingIds: this.pendingTaxReturns.map((t) => t.fromId),
      options: this.options,
    };
  }

  // ── 내부 헬퍼 ────────────────────────────────────────────────

  private requirePlayer(id: string): EnginePlayer {
    const p = this.players.find((x) => x.id === id);
    if (!p) throw new GameError('PLAYER_NOT_FOUND');
    return p;
  }

  private assertTurn(playerId: string): void {
    if (this.phase !== 'PLAYING') throw new GameError('WRONG_PHASE');
    if (this.currentPlayer?.id !== playerId) throw new GameError('NOT_YOUR_TURN');
  }
}

/** 완주 순서 → 계급. 1등 대달무티, 2등 소달무티, 꼴찌 대농노, 꼴찌 앞 소농노 */
export function rankForPlace(place: number, numPlayers: number): SocialRank {
  if (place === 1) return 'GREATER_DALMUTI';
  if (place === 2) return 'LESSER_DALMUTI';
  if (place === numPlayers) return 'GREATER_PEON';
  if (place === numPlayers - 1) return 'LESSER_PEON';
  return 'MERCHANT';
}
