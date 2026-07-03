import { JESTER_RANK } from './constants';
import type { Card, FieldState } from './types';

export type Combo = {
  cards: Card[];
  count: number;
  /** 조합의 숫자. 광대만으로 구성되면 13 */
  effectiveRank: number;
  jesterCount: number;
};

/**
 * 카드 묶음이 유효한 조합인지 분석한다.
 * 유효 조건: 광대를 제외한 카드가 모두 같은 숫자.
 * 광대는 와일드로 섞을 수 있고, 광대만 내면 숫자 13 취급.
 */
export function analyzeCombo(cards: readonly Card[]): Combo | null {
  if (cards.length === 0) return null;
  const ids = new Set(cards.map((c) => c.id));
  if (ids.size !== cards.length) return null; // 중복 카드

  const nonJesterRanks = new Set(
    cards.filter((c) => c.rank !== JESTER_RANK).map((c) => c.rank),
  );
  if (nonJesterRanks.size > 1) return null;

  const effectiveRank =
    nonJesterRanks.size === 1 ? [...nonJesterRanks][0]! : JESTER_RANK;
  const jesterCount = cards.filter((c) => c.rank === JESTER_RANK).length;

  return { cards: [...cards], count: cards.length, effectiveRank, jesterCount };
}

/** 필드의 조합을 이길 수 있는가: 같은 장수 + 더 낮은(강한) 숫자 */
export function canBeat(
  field: Pick<FieldState, 'count' | 'effectiveRank'>,
  combo: Combo,
): boolean {
  return combo.count === field.count && combo.effectiveRank < field.effectiveRank;
}

/** 손패에서 id 목록에 해당하는 카드를 찾는다. 하나라도 없으면 null */
export function pickCardsFromHand(
  hand: readonly Card[],
  cardIds: readonly string[],
): Card[] | null {
  const byId = new Map(hand.map((c) => [c.id, c]));
  const picked: Card[] = [];
  const used = new Set<string>();
  for (const id of cardIds) {
    if (used.has(id)) return null;
    const card = byId.get(id);
    if (!card) return null;
    used.add(id);
    picked.push(card);
  }
  return picked;
}

/** 손패에서 해당 id 카드들을 제거한 새 배열 (정렬 순서 유지) */
export function removeCardsFromHand(
  hand: readonly Card[],
  cardIds: readonly string[],
): Card[] {
  const ids = new Set(cardIds);
  return hand.filter((c) => !ids.has(c.id));
}

/**
 * 손패에서 필드를 이길 수 있는 모든 조합을 열거한다 (봇/힌트용).
 * field가 null이면 리드 상황: 낼 수 있는 모든 조합을 반환.
 * 반환되는 각 조합은 [같은 숫자 카드들 + 필요한 만큼의 광대] 형태.
 */
export function enumeratePlayableCombos(
  hand: readonly Card[],
  field: Pick<FieldState, 'count' | 'effectiveRank'> | null,
): Card[][] {
  const jesters = hand.filter((c) => c.rank === JESTER_RANK);
  const byRank = new Map<number, Card[]>();
  for (const c of hand) {
    if (c.rank === JESTER_RANK) continue;
    const list = byRank.get(c.rank) ?? [];
    list.push(c);
    byRank.set(c.rank, list);
  }

  const results: Card[][] = [];
  const pushIfBeats = (cards: Card[], effectiveRank: number) => {
    if (field === null) {
      results.push(cards);
      return;
    }
    if (cards.length === field.count && effectiveRank < field.effectiveRank) {
      results.push(cards);
    }
  };

  for (const [rank, cards] of byRank) {
    // 같은 숫자 n장 + 광대 j장 조합 전부
    for (let n = 1; n <= cards.length; n++) {
      for (let j = 0; j <= jesters.length; j++) {
        pushIfBeats([...cards.slice(0, n), ...jesters.slice(0, j)], rank);
      }
    }
  }
  // 광대 단독 조합 (숫자 13)
  for (let j = 1; j <= jesters.length; j++) {
    pushIfBeats(jesters.slice(0, j), JESTER_RANK);
  }
  return results;
}
