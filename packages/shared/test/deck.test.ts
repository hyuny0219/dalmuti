import { describe, expect, it } from 'vitest';
import { createDeck, deal, shuffle, sortHand } from '../src/deck';
import { JESTER_RANK, TOTAL_CARDS } from '../src/constants';

describe('createDeck', () => {
  it('80장: 숫자 N 카드 N장 + 광대 2장', () => {
    const deck = createDeck();
    expect(deck).toHaveLength(TOTAL_CARDS);
    for (let rank = 1; rank <= 12; rank++) {
      expect(deck.filter((c) => c.rank === rank)).toHaveLength(rank);
    }
    expect(deck.filter((c) => c.rank === JESTER_RANK)).toHaveLength(2);
  });

  it('카드 id는 전부 고유하다', () => {
    const deck = createDeck();
    expect(new Set(deck.map((c) => c.id)).size).toBe(deck.length);
  });
});

describe('shuffle', () => {
  it('카드 구성을 보존한다', () => {
    const deck = createDeck();
    const shuffled = shuffle(deck);
    expect(shuffled).toHaveLength(deck.length);
    expect(new Set(shuffled.map((c) => c.id))).toEqual(new Set(deck.map((c) => c.id)));
  });

  it('같은 rng 시드면 같은 결과 (결정적)', () => {
    const mkRng = () => {
      let s = 42;
      return () => {
        s = (s * 1103515245 + 12345) % 2147483648;
        return s / 2147483648;
      };
    };
    const a = shuffle(createDeck(), mkRng());
    const b = shuffle(createDeck(), mkRng());
    expect(a.map((c) => c.id)).toEqual(b.map((c) => c.id));
  });

  it('원본 배열을 변경하지 않는다', () => {
    const deck = createDeck();
    const ids = deck.map((c) => c.id);
    shuffle(deck);
    expect(deck.map((c) => c.id)).toEqual(ids);
  });
});

describe('deal', () => {
  it('모든 카드를 남김없이 분배한다', () => {
    for (let n = 4; n <= 10; n++) {
      const hands = deal(createDeck(), n);
      expect(hands.flat()).toHaveLength(TOTAL_CARDS);
      const sizes = hands.map((h) => h.length);
      expect(Math.max(...sizes) - Math.min(...sizes)).toBeLessThanOrEqual(1);
    }
  });

  it('firstSeat부터 분배해 추가 카드를 받는 좌석을 돌릴 수 있다', () => {
    // 6인: 80 = 6*13 + 2 → 2개 좌석이 14장을 받는다
    const seat0 = deal(createDeck(), 6, 0).map((h) => h.length);
    expect(seat0).toEqual([14, 14, 13, 13, 13, 13]);
    const seat3 = deal(createDeck(), 6, 3).map((h) => h.length);
    expect(seat3).toEqual([13, 13, 13, 14, 14, 13]);
  });
});

describe('shuffle 경계값', () => {
  it('rng가 1을 반환해도 카드가 유실되지 않는다', () => {
    const shuffled = shuffle(createDeck(), () => 1);
    expect(shuffled).toHaveLength(TOTAL_CARDS);
    expect(shuffled.every((c) => c !== undefined)).toBe(true);
  });
});

describe('sortHand', () => {
  it('강한 카드(낮은 숫자)부터 정렬, 광대는 마지막', () => {
    const sorted = sortHand([
      { id: 'j-1', rank: 13 },
      { id: 'r12-1', rank: 12 },
      { id: 'r1-1', rank: 1 },
      { id: 'r5-1', rank: 5 },
    ]);
    expect(sorted.map((c) => c.rank)).toEqual([1, 5, 12, 13]);
  });
});
