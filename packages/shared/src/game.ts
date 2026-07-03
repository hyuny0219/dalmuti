import { JESTER_RANK, MAX_PLAYERS, MIN_PLAYERS } from './constants';
import { createDeck, deal, shuffle, sortHand } from './deck';
import { analyzeCombo, canBeat, pickCardsFromHand, removeCardsFromHand } from './rules';
import {
  type BotDifficulty,
  type Card,
  type FieldState,
  GameError,
  type GameEvent,
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
  trickEnded: boolean;
  /** 트릭을 실제로 이긴(마지막으로 낸) 플레이어. 트릭이 안 끝났으면 null */
  trickWonBy: string | null;
  /** 다음 트릭을 리드할 플레이어. 승자가 완주했으면 승자와 다를 수 있다 */
  nextLeaderId: string | null;
};

/**
 * 달무티 게임 엔진.
 * 순수 인메모리 상태 머신 — I/O, 타이머, 소켓을 전혀 모른다.
 * 모든 상태 변경은 메서드를 통해서만 일어나고 잘못된 요청은 GameError를 던진다.
 * 상태 전이 중 발생한 일들은 이벤트 로그에 쌓이며 drainEvents()로 소비한다
 * (서버가 시스템 메시지/애니메이션 브로드캐스트를 만들 때 사용).
 */
export class DalmutiGame {
  readonly options: GameOptions;
  private _phase: GamePhase = 'ROUND_END'; // startRound 전 초기 상태
  private _round = 0;
  private _players: EnginePlayer[] = [];
  private _turnIndex: number | null = null;
  private _field: FieldState | null = null;
  private _revolution: { declaredById: string | null; isGreat: boolean } | null = null;
  private pendingTaxReturns: PendingTaxReturn[] = [];
  private revolutionCandidateId: string | null = null;
  private events: GameEvent[] = [];
  private readonly rng: () => number;
  private readonly deckFactory: (() => Card[]) | null;

  constructor(
    players: EnginePlayerInit[],
    options: GameOptions,
    rng: () => number = Math.random,
    /** 테스트용: 셔플 대신 지정된 덱을 좌석 0부터 순서대로 분배 */
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
    this._players = players.map((p) => ({
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

  // ── 조회 (읽기 전용 접근) ────────────────────────────────────

  get phase(): GamePhase {
    return this._phase;
  }

  get round(): number {
    return this._round;
  }

  get field(): FieldState | null {
    return this._field;
  }

  get currentPlayer(): EnginePlayer | null {
    return this._turnIndex === null ? null : this._players[this._turnIndex]!;
  }

  /** 완주한 플레이어 수 (파생값 — 별도 카운터를 두지 않는다) */
  private get finishedCount(): number {
    return this._players.filter((p) => p.finishedPlace !== null).length;
  }

  // ── 라운드 시작 ──────────────────────────────────────────────

  /** 새 라운드 시작: 좌석 재배치(계급순) → 분배 → 혁명/세금/플레이 단계 진입 */
  startRound(): void {
    if (this._phase !== 'ROUND_END') {
      throw new GameError('WRONG_PHASE', '라운드가 진행 중이거나 게임이 끝났습니다');
    }
    this._round += 1;

    // 이전 라운드 계급 순(=완주 순)으로 좌석 재배치
    if (this._round > 1) {
      this._players.sort(
        (a, b) => (a.finishedPlace ?? 99) - (b.finishedPlace ?? 99),
      );
    }

    const n = this._players.length;
    const deck = this.deckFactory ? this.deckFactory() : shuffle(createDeck(), this.rng);
    // 80장이 인원수로 나눠떨어지지 않으면 남는 카드를 받는 좌석이 생긴다.
    // 시작 좌석을 라운드마다 무작위로 돌려 특정 계급(대달무티=좌석 0)에
    // 추가 카드 부담이 고정되지 않게 한다. 테스트 덱은 좌석 0 고정.
    const firstSeat = this.deckFactory ? 0 : Math.floor(this.rng() * n);
    const hands = deal(deck, n, firstSeat);
    this._players.forEach((p, i) => {
      p.hand = sortHand(hands[i]!);
      p.finishedPlace = null;
    });
    this._field = null;
    this._revolution = null;
    this.pendingTaxReturns = [];
    this.revolutionCandidateId = null;
    this.events.push({ type: 'ROUND_STARTED', round: this._round });

    // 첫 라운드는 계급이 없으므로 혁명/세금 없이 무작위 리드로 시작
    if (this._round === 1) {
      this._phase = 'PLAYING';
      this._turnIndex = Math.floor(this.rng() * n);
      return;
    }

    // 혁명: 광대 2장을 모두 가진 플레이어가 있으면 선언 기회를 준다
    if (this.options.enableRevolution) {
      const holder = this._players.find(
        (p) => p.hand.filter((c) => c.rank === JESTER_RANK).length === 2,
      );
      if (holder) {
        this.revolutionCandidateId = holder.id;
        this._phase = 'REVOLUTION';
        this._turnIndex = null;
        this.events.push({ type: 'REVOLUTION_PENDING', playerId: holder.id });
        return;
      }
    }
    this.enterTaxationOrPlay();
  }

  private enterTaxationOrPlay(): void {
    if (this.options.enableTaxation && !this._revolution?.declaredById) {
      this.startTaxation();
      if (this.pendingTaxReturns.length > 0) return;
    }
    this.startPlaying();
  }

  /** 농노 → 달무티 상납은 자동(최고 카드 강제), 달무티의 반환 선택만 대기 */
  private startTaxation(): void {
    const byRank = (r: SocialRank) => this._players.find((p) => p.rank === r);
    const exchanges: Array<{ peon?: EnginePlayer; dalmuti?: EnginePlayer; n: number }> = [
      { peon: byRank('GREATER_PEON'), dalmuti: byRank('GREATER_DALMUTI'), n: 2 },
      { peon: byRank('LESSER_PEON'), dalmuti: byRank('LESSER_DALMUTI'), n: 1 },
    ];
    this._phase = 'TAXATION';
    this._turnIndex = null;
    for (const { peon, dalmuti, n } of exchanges) {
      if (!peon || !dalmuti) continue;
      // 최고 카드 = 숫자가 가장 낮은 카드 (손패는 분배 시 정렬 유지)
      const best = sortHand(peon.hand).slice(0, n);
      peon.hand = removeCardsFromHand(peon.hand, best.map((c) => c.id));
      dalmuti.hand = sortHand([...dalmuti.hand, ...best]);
      this.pendingTaxReturns.push({ fromId: dalmuti.id, toId: peon.id, count: n });
      this.events.push({
        type: 'TAX_TRIBUTE',
        fromId: peon.id,
        toId: dalmuti.id,
        cardIds: best.map((c) => c.id),
      });
    }
  }

  private startPlaying(): void {
    this._phase = 'PLAYING';
    // 리드: 대달무티(혁명으로 바뀌었을 수 있음), 없으면 좌석 0
    const leader = this._players.findIndex((p) => p.rank === 'GREATER_DALMUTI');
    this._turnIndex = leader >= 0 ? leader : 0;
  }

  // ── 혁명 ────────────────────────────────────────────────────

  declareRevolution(playerId: string, declare: boolean): void {
    if (this._phase !== 'REVOLUTION') throw new GameError('WRONG_PHASE');
    if (playerId !== this.revolutionCandidateId) {
      throw new GameError('CANNOT_DECLARE_REVOLUTION', '광대 2장을 가진 플레이어만 선언할 수 있습니다');
    }
    if (!declare) {
      this.events.push({ type: 'REVOLUTION_DECLINED', playerId });
      this.enterTaxationOrPlay();
      return;
    }
    const declarer = this.requirePlayer(playerId);
    const isGreat = declarer.rank === 'GREATER_PEON';
    this._revolution = { declaredById: playerId, isGreat };
    this.events.push({ type: 'REVOLUTION_DECLARED', playerId, isGreat });
    if (isGreat) {
      // 대혁명: 서열 완전 역전. 좌석은 이전 계급 순이므로 배열을 뒤집고
      // 새 좌석 순서대로 계급을 다시 부여한다 (상인 순서까지 포함한 완전 역전)
      this._players.reverse();
      const n = this._players.length;
      this._players.forEach((p, i) => {
        p.rank = rankForPlace(i + 1, n);
      });
    }
    // 혁명이 선언되면 이번 라운드 세금 면제
    this.startPlaying();
  }

  // ── 세금 ────────────────────────────────────────────────────

  /** 달무티가 농노에게 되돌려줄 카드를 선택 */
  payTaxReturn(playerId: string, cardIds: string[]): void {
    if (this._phase !== 'TAXATION') throw new GameError('WRONG_PHASE');
    const pending = this.pendingTaxReturns.find((t) => t.fromId === playerId);
    if (!pending) throw new GameError('NOT_TAX_PAYER', '반환할 세금이 없습니다');
    if (cardIds.length !== pending.count) {
      throw new GameError('WRONG_TAX_CARDS', `${pending.count}장을 선택해야 합니다`);
    }
    const giver = this.requirePlayer(playerId);
    const cards = pickCardsFromHand(giver.hand, cardIds);
    if (!cards) throw new GameError('CARDS_NOT_IN_HAND');

    const receiver = this.requirePlayer(pending.toId);
    giver.hand = removeCardsFromHand(giver.hand, cardIds);
    receiver.hand = sortHand([...receiver.hand, ...cards]);
    this.pendingTaxReturns = this.pendingTaxReturns.filter((t) => t !== pending);
    this.events.push({
      type: 'TAX_RETURN',
      fromId: playerId,
      toId: pending.toId,
      cardIds: [...cardIds],
    });

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
    if (this._field && !canBeat(this._field, combo)) {
      throw new GameError(
        'CANNOT_BEAT_FIELD',
        `${this._field.count}장, ${this._field.effectiveRank}보다 낮은 숫자만 낼 수 있습니다`,
      );
    }

    player.hand = removeCardsFromHand(player.hand, cardIds);
    this._field = {
      cards: combo.cards,
      count: combo.count,
      effectiveRank: combo.effectiveRank,
      ownerId: playerId,
    };
    this.events.push({ type: 'PLAYED', playerId, cards: [...combo.cards] });

    let playerFinished = false;
    if (player.hand.length === 0) {
      playerFinished = true;
      player.finishedPlace = this.finishedCount + 1;
      this.events.push({
        type: 'PLAYER_FINISHED',
        playerId,
        place: player.finishedPlace,
      });
    }

    const remaining = this._players.filter((p) => p.hand.length > 0);
    if (remaining.length <= 1) {
      return { playerFinished, ...this.endRound(remaining[0]) };
    }

    this.advanceTurn();
    return { playerFinished, roundEnded: false, gameEnded: false };
  }

  pass(playerId: string): PassResult {
    this.assertTurn(playerId);
    if (!this._field) {
      throw new GameError('LEADER_MUST_PLAY', '리드 플레이어는 패스할 수 없습니다');
    }
    const ownerId = this._field.ownerId;
    this.events.push({ type: 'PASSED', playerId });
    this.advanceTurn();
    // advanceTurn이 트릭을 끝냈다면 field가 비워져 있다
    const trickEnded = this._field === null;
    return {
      trickEnded,
      trickWonBy: trickEnded ? ownerId : null,
      nextLeaderId: trickEnded ? this.currentPlayer!.id : null,
    };
  }

  /**
   * 다음 차례 계산. 필드 주인 좌석에 도달하면 트릭 종료:
   * 주인이 리드를 얻거나, 주인이 이미 완주했으면 다음 미완주자가 리드.
   */
  private advanceTurn(): void {
    const n = this._players.length;
    for (let k = 1; k <= n; k++) {
      const idx = (this._turnIndex! + k) % n;
      const p = this._players[idx]!;
      if (this._field && p.id === this._field.ownerId) {
        const ownerId = this._field.ownerId;
        this._field = null;
        this._turnIndex = p.hand.length > 0 ? idx : this.nextActiveIndexAfter(idx);
        this.events.push({
          type: 'TRICK_WON',
          playerId: ownerId,
          nextLeaderId: this.currentPlayer!.id,
        });
        return;
      }
      if (p.hand.length > 0) {
        this._turnIndex = idx;
        return;
      }
    }
    // 여기 도달 = 남은 플레이어가 없다는 뜻인데, play()에서 라운드 종료를
    // 먼저 처리하므로 정상 흐름에선 불가능
    throw new GameError('WRONG_PHASE', '진행 가능한 플레이어가 없습니다');
  }

  private nextActiveIndexAfter(idx: number): number {
    const n = this._players.length;
    for (let k = 1; k <= n; k++) {
      const i = (idx + k) % n;
      if (this._players[i]!.hand.length > 0) return i;
    }
    throw new GameError('WRONG_PHASE', '진행 가능한 플레이어가 없습니다');
  }

  // ── 라운드/게임 종료 ─────────────────────────────────────────

  private endRound(lastPlayer: EnginePlayer | undefined): {
    roundEnded: true;
    gameEnded: boolean;
  } {
    if (lastPlayer) {
      lastPlayer.finishedPlace = this.finishedCount + 1;
      lastPlayer.hand = [];
    }
    const n = this._players.length;
    for (const p of this._players) {
      p.rank = rankForPlace(p.finishedPlace!, n);
      p.score += n - p.finishedPlace!;
    }
    this._field = null;
    this._turnIndex = null;
    this.events.push({
      type: 'ROUND_ENDED',
      round: this._round,
      placements: this._players.map((p) => ({
        playerId: p.id,
        place: p.finishedPlace!,
        rank: p.rank!,
      })),
    });
    const gameEnded = this._round >= this.options.targetRounds;
    if (gameEnded) {
      this._phase = 'GAME_END';
      this.events.push({ type: 'GAME_ENDED', round: this._round });
    } else {
      this._phase = 'ROUND_END';
    }
    return { roundEnded: true, gameEnded };
  }

  // ── 이벤트/스냅샷 ────────────────────────────────────────────

  /** 마지막 호출 이후 쌓인 이벤트를 꺼내고 비운다 (서버 브로드캐스트용) */
  drainEvents(): GameEvent[] {
    const drained = this.events;
    this.events = [];
    return drained;
  }

  getHandOf(playerId: string): Card[] {
    return [...this.requirePlayer(playerId).hand];
  }

  /** 세금 반환 대기 중인 플레이어의 반환 장수 (본인 전용 안내) */
  getPendingTaxReturn(playerId: string): { count: number } | null {
    const t = this.pendingTaxReturns.find((x) => x.fromId === playerId);
    return t ? { count: t.count } : null;
  }

  getRevolutionCandidateId(): string | null {
    return this._phase === 'REVOLUTION' ? this.revolutionCandidateId : null;
  }

  /** 공개 상태 스냅샷. 내부 상태와 참조를 공유하지 않는다 (변조 방지) */
  getPublicState(): GamePublicState {
    return {
      phase: this._phase,
      round: this._round,
      targetRounds: this.options.targetRounds,
      players: this._players.map((p): PlayerPublic => ({
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
      field: this._field
        ? { ...this._field, cards: this._field.cards.map((c) => ({ ...c })) }
        : null,
      revolution: this._revolution ? { ...this._revolution } : null,
      revolutionCandidateId: this.getRevolutionCandidateId(),
      taxationPendingIds: this.pendingTaxReturns.map((t) => t.fromId),
      options: { ...this.options },
    };
  }

  /** 접속 상태 갱신 (서버 계층에서 사용) */
  setConnected(playerId: string, connected: boolean): void {
    this.requirePlayer(playerId).connected = connected;
  }

  // ── 내부 헬퍼 ────────────────────────────────────────────────

  private requirePlayer(id: string): EnginePlayer {
    const p = this._players.find((x) => x.id === id);
    if (!p) throw new GameError('PLAYER_NOT_FOUND');
    return p;
  }

  private assertTurn(playerId: string): void {
    if (this._phase !== 'PLAYING') throw new GameError('WRONG_PHASE');
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
