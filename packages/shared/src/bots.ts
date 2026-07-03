import { JESTER_COUNT, JESTER_RANK } from './constants';
import { analyzeCombo, enumeratePlayableCombos, type Combo } from './rules';
import { shuffle } from './deck';
import type {
  BotDifficulty,
  Card,
  FieldState,
  PlayerPublic,
  SocialRank,
} from './types';

/**
 * 봇이 볼 수 있는 정보만 담은 뷰.
 * 사람 플레이어와 동일한 정보(자기 손패 + 공개 정보)만 제공한다 — 공정성 원칙.
 */
export type BotView = {
  myId: string;
  myRank: SocialRank | null;
  hand: Card[];
  field: FieldState | null;
  players: PlayerPublic[];
  /** 이번 라운드에 이미 공개(플레이)된 카드의 숫자별 장수 */
  playedRankCounts: Record<number, number>;
};

export type BotDecision = { type: 'play'; cardIds: string[] } | { type: 'pass' };

export interface BotStrategy {
  decidePlay(view: BotView): BotDecision;
  /** 세금 반환으로 돌려줄 카드 선택 */
  decideTaxReturn(view: BotView, count: number): string[];
  decideRevolution(view: BotView): boolean;
}

// ── 공통 헬퍼 ──────────────────────────────────────────────────

type ScoredCombo = { cards: Card[]; combo: Combo };

function playableCombos(view: BotView): ScoredCombo[] {
  return enumeratePlayableCombos(view.hand, view.field).map((cards) => ({
    cards,
    combo: analyzeCombo(cards)!,
  }));
}

/** 손패를 숫자별 그룹으로 (광대 제외) */
function groupByRank(hand: readonly Card[]): Map<number, Card[]> {
  const groups = new Map<number, Card[]>();
  for (const c of hand) {
    if (c.rank === JESTER_RANK) continue;
    const list = groups.get(c.rank) ?? [];
    list.push(c);
    groups.set(c.rank, list);
  }
  return groups;
}

function totalOfRank(rank: number): number {
  return rank === JESTER_RANK ? JESTER_COUNT : rank;
}

const toPlay = (cards: Card[]): BotDecision => ({
  type: 'play',
  cardIds: cards.map((c) => c.id),
});

// ── easy: 무작위 ───────────────────────────────────────────────

class EasyBot implements BotStrategy {
  constructor(private readonly rng: () => number) {}

  decidePlay(view: BotView): BotDecision {
    const combos = playableCombos(view);
    if (combos.length === 0) return { type: 'pass' };
    // 낼 수 있어도 30% 확률로 패스 (리드일 땐 패스 불가)
    if (view.field && this.rng() < 0.3) return { type: 'pass' };
    const pick = combos[Math.floor(this.rng() * combos.length)]!;
    return toPlay(pick.cards);
  }

  decideTaxReturn(view: BotView, count: number): string[] {
    return shuffle(view.hand, this.rng)
      .slice(0, count)
      .map((c) => c.id);
  }

  decideRevolution(): boolean {
    return false;
  }
}

// ── normal: 탐욕 휴리스틱 ──────────────────────────────────────

class NormalBot implements BotStrategy {
  decidePlay(view: BotView): BotDecision {
    const combos = playableCombos(view);
    if (combos.length === 0) return { type: 'pass' };
    // 광대를 아끼고, 가장 약한(높은 숫자) 조합부터, 리드라면 많이 털어내는 쪽 우선
    const sorted = [...combos].sort(
      (a, b) =>
        a.combo.jesterCount - b.combo.jesterCount ||
        b.combo.effectiveRank - a.combo.effectiveRank ||
        b.combo.count - a.combo.count,
    );
    return toPlay(sorted[0]!.cards);
  }

  decideTaxReturn(view: BotView, count: number): string[] {
    // 광대는 지키고 가장 약한(높은 숫자) 카드 반환
    const candidates = [...view.hand].sort((a, b) => {
      const av = a.rank === JESTER_RANK ? -1 : a.rank;
      const bv = b.rank === JESTER_RANK ? -1 : b.rank;
      return bv - av;
    });
    return candidates.slice(0, count).map((c) => c.id);
  }

  decideRevolution(view: BotView): boolean {
    // 대혁명(계급 역전)일 때만 선언
    return view.myRank === 'GREATER_PEON';
  }
}

// ── hard: 카드 카운팅 + 그룹 플랜 ──────────────────────────────

class HardBot implements BotStrategy {
  /** 내 손패/공개 카드를 제외하고 상대들이 들고 있을 수 있는 rank별 장수 */
  private unseen(view: BotView, rank: number): number {
    const mine = view.hand.filter((c) => c.rank === rank).length;
    const played = view.playedRankCounts[rank] ?? 0;
    return Math.max(0, totalOfRank(rank) - mine - played);
  }

  /** (count장, rank 조합)을 상대가 이길 수 있는가 — 카운팅 기반, 광대 패딩 포함 보수적 판단 */
  private isBeatable(view: BotView, count: number, rank: number): boolean {
    const unseenJesters = this.unseen(view, JESTER_RANK);
    for (let r = 1; r < rank; r++) {
      if (this.unseen(view, r) + unseenJesters >= count) return true;
    }
    return false;
  }

  decidePlay(view: BotView): BotDecision {
    const combos = playableCombos(view);
    if (combos.length === 0) return { type: 'pass' };
    const groups = groupByRank(view.hand);
    const jesters = view.hand.filter((c) => c.rank === JESTER_RANK);

    if (!view.field) {
      // 마지막 그룹(+광대)이면 전부 던져 즉시 완주
      if (groups.size <= 1) {
        const last = groups.size === 1 ? [...groups.values()][0]! : [];
        const all = [...last, ...jesters];
        if (all.length > 0 && analyzeCombo(all)) return toPlay(all);
      }
      // 잡힐 수 있는 그룹 중 가장 약한 것을 풀 그룹으로 리드 (버릴 것부터 버린다).
      // 전부 안 잡히는 그룹뿐이면 가장 약한 것 — 어차피 리드를 유지한다.
      const byWeakness = [...groups.entries()].sort((a, b) => b[0] - a[0]);
      const beatable = byWeakness.find(([rank, cards]) =>
        this.isBeatable(view, cards.length, rank),
      );
      const [, cards] = beatable ?? byWeakness[0]!;
      return toPlay(cards);
    }

    // 필드 대응: 피해(damage)가 가장 적은 수 선택.
    // 달무티는 빨리 터는 게 핵심 — 이길 수 있으면 대체로 이기고,
    // 패스는 정말 비싼 수(그룹 파괴 + 광대 소모)뿐일 때만 한다.
    let best: { cards: Card[]; damage: number; rank: number } | null = null;
    for (const { cards, combo } of combos) {
      const groupSize = groups.get(combo.effectiveRank)?.length ?? 0;
      const breaksGroup =
        combo.effectiveRank !== JESTER_RANK &&
        combo.count - combo.jesterCount < groupSize;
      // 온전한 그룹을 정확히 소진하는 클린 플레이 선호
      const clean = !breaksGroup && combo.jesterCount === 0;
      // 상대가 못 잡는 그룹(리드 유지 자산)을 깨는 경우만 가볍게 페널티
      const spendsControl =
        breaksGroup &&
        !this.isBeatable(view, groupSize, combo.effectiveRank);
      const finishes = combo.count === view.hand.length;
      const damage =
        combo.jesterCount * 2 +
        (breaksGroup ? 1 : 0) +
        (spendsControl ? 2 : 0) -
        (clean ? 1 : 0) -
        (finishes ? 10 : 0);
      if (
        !best ||
        damage < best.damage ||
        (damage === best.damage && combo.effectiveRank > best.rank)
      ) {
        best = { cards, damage, rank: combo.effectiveRank };
      }
    }
    // 광대 2장을 태우면서 컨트롤 그룹까지 깨야 하는 극단적인 경우에만 패스
    if (best!.damage >= 6 && groups.size >= 4) return { type: 'pass' };
    return toPlay(best!.cards);
  }

  decideTaxReturn(view: BotView, count: number): string[] {
    const groups = groupByRank(view.hand);
    // 버리기 좋은 카드일수록 점수가 높다: 약하고(숫자 큼), 외톨이이고, 컨트롤 그룹이 아닌 것
    const score = (c: Card): number => {
      if (c.rank === JESTER_RANK) return -99; // 광대는 지킨다
      const size = groups.get(c.rank)?.length ?? 1;
      const control = !this.isBeatable(view, size, c.rank);
      return c.rank + (size === 1 ? 3 : 0) - (control ? 8 : 0);
    };
    return [...view.hand]
      .sort((a, b) => score(b) - score(a))
      .slice(0, count)
      .map((c) => c.id);
  }

  decideRevolution(view: BotView): boolean {
    // 세금은 농노에게 불리 — 농노 계급이면 선언 (대농노는 대혁명 보너스)
    return view.myRank === 'GREATER_PEON' || view.myRank === 'LESSER_PEON';
  }
}

export function createBotStrategy(
  difficulty: BotDifficulty,
  rng: () => number = Math.random,
): BotStrategy {
  switch (difficulty) {
    case 'easy':
      return new EasyBot(rng);
    case 'normal':
      return new NormalBot();
    case 'hard':
      return new HardBot();
  }
}
