import { describe, expect, it } from 'vitest';
import {
  analyzeCombo,
  canBeat,
  enumeratePlayableCombos,
  pickCardsFromHand,
} from '../src/rules';
import type { Card } from '../src/types';

const c = (rank: number, n = 1): Card => ({ id: `r${rank}-${n}`, rank });
const jester = (n = 1): Card => ({ id: `j-${n}`, rank: 13 });

describe('analyzeCombo', () => {
  it('단일 카드', () => {
    expect(analyzeCombo([c(7)])).toMatchObject({ count: 1, effectiveRank: 7 });
  });

  it('같은 숫자 여러 장', () => {
    expect(analyzeCombo([c(9, 1), c(9, 2), c(9, 3)])).toMatchObject({
      count: 3,
      effectiveRank: 9,
    });
  });

  it('광대를 와일드로 섞은 조합', () => {
    expect(analyzeCombo([c(5, 1), c(5, 2), jester()])).toMatchObject({
      count: 3,
      effectiveRank: 5,
      jesterCount: 1,
    });
  });

  it('광대만 내면 숫자 13', () => {
    expect(analyzeCombo([jester(1), jester(2)])).toMatchObject({
      count: 2,
      effectiveRank: 13,
    });
  });

  it('서로 다른 숫자는 무효', () => {
    expect(analyzeCombo([c(5), c(6)])).toBeNull();
  });

  it('빈 배열은 무효', () => {
    expect(analyzeCombo([])).toBeNull();
  });

  it('중복 카드 id는 무효', () => {
    expect(analyzeCombo([c(5, 1), c(5, 1)])).toBeNull();
  });
});

describe('canBeat', () => {
  const field = { count: 2, effectiveRank: 8 };

  it('같은 장수 + 낮은 숫자면 이긴다', () => {
    expect(canBeat(field, analyzeCombo([c(5, 1), c(5, 2)])!)).toBe(true);
  });

  it('같은 숫자는 못 이긴다', () => {
    expect(canBeat(field, analyzeCombo([c(8, 1), c(8, 2)])!)).toBe(false);
  });

  it('장수가 다르면 못 이긴다', () => {
    expect(canBeat(field, analyzeCombo([c(3, 1)])!)).toBe(false);
    expect(canBeat(field, analyzeCombo([c(3, 1), c(3, 2), c(3, 3)])!)).toBe(false);
  });

  it('광대 섞은 조합의 유효 숫자로 판정한다', () => {
    expect(canBeat(field, analyzeCombo([c(6, 1), jester()])!)).toBe(true);
  });

  it('광대 단독(13)은 어떤 숫자로도 잡을 수 있다', () => {
    const jesterField = { count: 1, effectiveRank: 13 };
    expect(canBeat(jesterField, analyzeCombo([c(12)])!)).toBe(true);
  });
});

describe('pickCardsFromHand', () => {
  const hand = [c(5, 1), c(5, 2), jester()];

  it('손패에 있는 카드를 찾는다', () => {
    expect(pickCardsFromHand(hand, ['r5-1', 'j-1'])).toHaveLength(2);
  });

  it('손패에 없는 카드는 null', () => {
    expect(pickCardsFromHand(hand, ['r5-1', 'r9-1'])).toBeNull();
  });

  it('같은 id 두 번 요청하면 null (복제 치팅 방지)', () => {
    expect(pickCardsFromHand(hand, ['r5-1', 'r5-1'])).toBeNull();
  });
});

describe('enumeratePlayableCombos', () => {
  it('리드 상황: 가능한 모든 조합', () => {
    const combos = enumeratePlayableCombos([c(5, 1), c(5, 2)], null);
    // [5], [5,5], 그리고 각 단일 5 → 실제로는 slice라 [5], [5,5] 두 형태
    expect(combos.length).toBeGreaterThanOrEqual(2);
  });

  it('필드를 이기는 조합만 반환', () => {
    const hand = [c(3, 1), c(3, 2), c(9, 1), c(9, 2), jester()];
    const combos = enumeratePlayableCombos(hand, { count: 2, effectiveRank: 8 });
    for (const combo of combos) {
      const nonJ = combo.filter((x) => x.rank !== 13);
      expect(combo).toHaveLength(2);
      expect(nonJ.every((x) => x.rank === 3)).toBe(true);
    }
    // 3+3, 3+광대 두 형태 이상 존재
    expect(combos.length).toBeGreaterThanOrEqual(2);
  });

  it('이길 수 없으면 빈 배열', () => {
    const combos = enumeratePlayableCombos([c(12, 1)], { count: 1, effectiveRank: 3 });
    expect(combos).toHaveLength(0);
  });

  it('광대 단독 조합도 열거된다', () => {
    const combos = enumeratePlayableCombos([jester(1), jester(2)], null);
    expect(combos.some((combo) => combo.every((x) => x.rank === 13))).toBe(true);
  });
});
