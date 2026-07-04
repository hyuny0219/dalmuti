import { describe, expect, it } from 'vitest';
import { DalmutiGame, rankForPlace } from '../src/game';
import { DEFAULT_GAME_OPTIONS, GameError, type Card, type GameOptions } from '../src/types';

const mkc = (id: string, rank: number): Card => ({ id, rank });

/** deal()은 deck[i % n]을 좌석 i에 주므로, 원하는 손패를 인터리브해서 덱으로 역구성 */
function stackDeck(hands: Card[][]): Card[] {
  const size = hands[0]!.length;
  if (!hands.every((h) => h.length === size)) {
    throw new Error('테스트 손패는 모두 같은 장수여야 합니다');
  }
  const deck: Card[] = [];
  for (let r = 0; r < size; r++) {
    for (const hand of hands) deck.push(hand[r]!);
  }
  return deck;
}

const PLAYERS = [
  { id: 'p1', nickname: '왕' },
  { id: 'p2', nickname: '귀족' },
  { id: 'p3', nickname: '상인' },
  { id: 'p4', nickname: '농노' },
];

function makeGame(decks: Card[][][], options: Partial<GameOptions> = {}): DalmutiGame {
  const queue = decks.map(stackDeck);
  const game = new DalmutiGame(
    PLAYERS,
    { ...DEFAULT_GAME_OPTIONS, ...options },
    () => 0, // 라운드 1 리드 = 좌석 0
    () => {
      const d = queue.shift();
      if (!d) throw new Error('준비된 덱이 없습니다');
      return d;
    },
  );
  return game;
}

/** 라운드 1: p1(5,5) → p2(4,4) → p3(3,3) → p4 남음. 완주 순서 p1>p2>p3>p4 */
const ROUND1_HANDS: Card[][] = [
  [mkc('a1', 5), mkc('a2', 5)],
  [mkc('b1', 4), mkc('b2', 4)],
  [mkc('c1', 3), mkc('c2', 3)],
  [mkc('d1', 12), mkc('d2', 12)],
];

function playRound1(game: DalmutiGame): void {
  game.startRound();
  game.play('p1', ['a1', 'a2']);
  game.play('p2', ['b1', 'b2']);
  game.play('p3', ['c1', 'c2']);
}

describe('DalmutiGame 생성', () => {
  it('4명 미만/10명 초과는 거부한다', () => {
    const three = PLAYERS.slice(0, 3);
    expect(() => new DalmutiGame(three, DEFAULT_GAME_OPTIONS)).toThrowError(
      expect.objectContaining({ code: 'INVALID_PLAYER_COUNT' }),
    );
    const eleven = Array.from({ length: 11 }, (_, i) => ({ id: `x${i}`, nickname: `x${i}` }));
    expect(() => new DalmutiGame(eleven, DEFAULT_GAME_OPTIONS)).toThrowError(
      expect.objectContaining({ code: 'INVALID_PLAYER_COUNT' }),
    );
  });

  it('10명 게임도 시작·분배된다 (인당 8장)', () => {
    const ten = Array.from({ length: 10 }, (_, i) => ({ id: `t${i}`, nickname: `t${i}` }));
    const game = new DalmutiGame(ten, DEFAULT_GAME_OPTIONS, () => 0);
    game.startRound();
    const state = game.getPublicState();
    expect(state.players).toHaveLength(10);
    expect(state.players.every((p) => p.handCount === 8)).toBe(true);
  });

  it('중복 id는 거부한다', () => {
    const dup = [...PLAYERS.slice(0, 3), { id: 'p1', nickname: '복제' }];
    expect(() => new DalmutiGame(dup, DEFAULT_GAME_OPTIONS)).toThrowError(GameError);
  });
});

describe('트릭 진행', () => {
  const TRICK_HANDS: Card[][] = [
    [mkc('a1', 10), mkc('a2', 10), mkc('a3', 1)],
    [mkc('b1', 7), mkc('b2', 7), mkc('b3', 2)],
    [mkc('c1', 11), mkc('c2', 11), mkc('c3', 9)],
    [mkc('d1', 12), mkc('d2', 12), mkc('d3', 9)],
  ];

  it('리드 플레이어는 패스할 수 없다', () => {
    const game = makeGame([TRICK_HANDS]);
    game.startRound();
    expect(() => game.pass('p1')).toThrowError(
      expect.objectContaining({ code: 'LEADER_MUST_PLAY' }),
    );
  });

  it('자기 차례가 아니면 낼 수 없다', () => {
    const game = makeGame([TRICK_HANDS]);
    game.startRound();
    expect(() => game.play('p2', ['b1'])).toThrowError(
      expect.objectContaining({ code: 'NOT_YOUR_TURN' }),
    );
  });

  it('손패에 없는 카드는 낼 수 없다', () => {
    const game = makeGame([TRICK_HANDS]);
    game.startRound();
    expect(() => game.play('p1', ['b1'])).toThrowError(
      expect.objectContaining({ code: 'CARDS_NOT_IN_HAND' }),
    );
  });

  it('서로 다른 숫자 조합은 무효', () => {
    const game = makeGame([TRICK_HANDS]);
    game.startRound();
    expect(() => game.play('p1', ['a1', 'a3'])).toThrowError(
      expect.objectContaining({ code: 'INVALID_COMBO' }),
    );
  });

  it('필드보다 약하거나 장수가 다르면 낼 수 없다', () => {
    const game = makeGame([TRICK_HANDS]);
    game.startRound();
    game.play('p1', ['a1', 'a2']); // 10 페어
    expect(() => game.play('p2', ['b1'])).toThrowError(
      expect.objectContaining({ code: 'CANNOT_BEAT_FIELD' }), // 장수 다름
    );
    expect(() => game.play('p2', ['b3'])).toThrowError(
      expect.objectContaining({ code: 'CANNOT_BEAT_FIELD' }),
    );
  });

  it('한 바퀴 모두 패스하면 마지막에 낸 사람이 새 리드를 가진다', () => {
    const game = makeGame([TRICK_HANDS]);
    game.startRound();
    game.play('p1', ['a1', 'a2']); // 10 페어
    game.play('p2', ['b1', 'b2']); // 7 페어로 이김
    expect(game.pass('p3').trickWonBy).toBeNull();
    expect(game.pass('p4').trickWonBy).toBeNull();
    const result = game.pass('p1'); // p1도 패스 → p2가 트릭 승리
    expect(result.trickEnded).toBe(true);
    expect(result.trickWonBy).toBe('p2');
    expect(result.nextLeaderId).toBe('p2');
    expect(game.field).toBeNull();
    expect(game.currentPlayer?.id).toBe('p2');
    // 새 리드는 패스 불가
    expect(() => game.pass('p2')).toThrowError(
      expect.objectContaining({ code: 'LEADER_MUST_PLAY' }),
    );
  });
});

describe('완주와 라운드 종료', () => {
  it('완주 순서대로 계급과 점수가 부여된다', () => {
    const game = makeGame([ROUND1_HANDS]);
    playRound1(game);

    expect(game.phase).toBe('ROUND_END');
    const state = game.getPublicState();
    const byId = Object.fromEntries(state.players.map((p) => [p.id, p]));
    expect(byId.p1).toMatchObject({ finishedPlace: 1, rank: 'GREATER_DALMUTI', score: 3 });
    expect(byId.p2).toMatchObject({ finishedPlace: 2, rank: 'LESSER_DALMUTI', score: 2 });
    expect(byId.p3).toMatchObject({ finishedPlace: 3, rank: 'LESSER_PEON', score: 1 });
    expect(byId.p4).toMatchObject({ finishedPlace: 4, rank: 'GREATER_PEON', score: 0 });
  });

  it('마지막 카드를 낸 플레이어의 완주가 기록된다', () => {
    const game = makeGame([ROUND1_HANDS]);
    game.startRound();
    const result = game.play('p1', ['a1', 'a2']);
    expect(result.playerFinished).toBe(true);
    expect(result.roundEnded).toBe(false);
  });

  it('targetRounds 도달 시 GAME_END', () => {
    const game = makeGame([ROUND1_HANDS], { targetRounds: 1 });
    playRound1(game);
    expect(game.phase).toBe('GAME_END');
  });

  it('필드 주인이 완주한 채 전원 패스하면 다음 미완주자가 리드', () => {
    const hands: Card[][] = [
      [mkc('a1', 5), mkc('a2', 5)],
      [mkc('b1', 9), mkc('b2', 9)],
      [mkc('c1', 10), mkc('c2', 10)],
      [mkc('d1', 11), mkc('d2', 11)],
    ];
    const game = makeGame([hands]);
    game.startRound();
    game.play('p1', ['a1', 'a2']); // p1 완주, 필드는 5 페어
    game.pass('p2');
    game.pass('p3');
    const result = game.pass('p4'); // 주인(p1) 자리 도달 → 트릭 종료
    expect(result.trickEnded).toBe(true);
    expect(result.trickWonBy).toBe('p1'); // 트릭 승자는 완주한 p1
    expect(result.nextLeaderId).toBe('p2'); // 리드는 다음 미완주자 p2
    expect(game.currentPlayer?.id).toBe('p2');
    expect(game.field).toBeNull();
  });
});

describe('광대(조커)', () => {
  it('광대를 섞은 조합으로 필드를 이길 수 있다', () => {
    const hands: Card[][] = [
      [mkc('a1', 8), mkc('a2', 8), mkc('a3', 12)],
      [mkc('b1', 6), mkc('j-1', 13), mkc('b3', 12)],
      [mkc('c1', 10), mkc('c2', 10), mkc('c3', 12)],
      [mkc('d1', 11), mkc('d2', 11), mkc('j-2', 13)],
    ];
    const game = makeGame([hands]);
    game.startRound();
    game.play('p1', ['a1', 'a2']); // 8 페어
    game.play('p2', ['b1', 'j-1']); // 6 + 광대 = 6 페어
    expect(game.field).toMatchObject({ count: 2, effectiveRank: 6 });
  });
});

describe('세금 (라운드 2+)', () => {
  // 라운드 2 좌석: 완주 순 p1(GD), p2(LD), p3(LP), p4(GP)
  const ROUND2_HANDS: Card[][] = [
    [mkc('g1', 6), mkc('g2', 7), mkc('g3', 8)], // GD
    [mkc('h1', 6), mkc('h2', 7), mkc('h3', 8)], // LD
    [mkc('i1', 2), mkc('i2', 11), mkc('i3', 11)], // LP → 최고 카드 2 상납
    [mkc('k1', 1), mkc('k2', 12), mkc('k3', 12)], // GP → 최고 카드 1,12 상납
  ];

  function toTaxation(): DalmutiGame {
    const game = makeGame([ROUND1_HANDS, ROUND2_HANDS]);
    playRound1(game);
    game.startRound();
    return game;
  }

  it('농노의 최고 카드가 자동 상납되고 달무티의 반환을 기다린다', () => {
    const game = toTaxation();
    expect(game.phase).toBe('TAXATION');

    const state = game.getPublicState();
    expect(new Set(state.taxationPendingIds)).toEqual(new Set(['p1', 'p2']));

    // GP(p4): 최고 2장(1, 12) 상납 → 1장 남음
    expect(game.getHandOf('p4').map((c) => c.id)).toEqual(['k3']);
    // GD(p1): 3 + 2 = 5장
    expect(game.getHandOf('p1')).toHaveLength(5);
    // LP(p3): 최고 1장(2) 상납
    expect(game.getHandOf('p3').map((c) => c.id).sort()).toEqual(['i2', 'i3']);
    expect(game.getHandOf('p2')).toHaveLength(4);
  });

  it('달무티가 반환을 마치면 PLAYING으로 넘어가고 대달무티가 리드한다', () => {
    const game = toTaxation();
    game.payTaxReturn('p1', ['g2', 'g3']);
    expect(game.phase).toBe('TAXATION'); // 소달무티가 아직
    game.payTaxReturn('p2', ['h3']);
    expect(game.phase).toBe('PLAYING');
    expect(game.currentPlayer?.id).toBe('p1');
    expect(game.getHandOf('p4')).toHaveLength(3); // 1 + 반환 2
    expect(game.getHandOf('p3')).toHaveLength(3);
  });

  it('반환 의무가 없는 플레이어는 거부된다', () => {
    const game = toTaxation();
    expect(() => game.payTaxReturn('p3', ['i2'])).toThrowError(
      expect.objectContaining({ code: 'NOT_TAX_PAYER' }),
    );
  });

  it('장수가 맞지 않으면 거부된다', () => {
    const game = toTaxation();
    expect(() => game.payTaxReturn('p1', ['g2'])).toThrowError(
      expect.objectContaining({ code: 'WRONG_TAX_CARDS' }),
    );
  });

  it('enableTaxation=false면 세금 없이 바로 PLAYING', () => {
    const game = makeGame([ROUND1_HANDS, ROUND2_HANDS], { enableTaxation: false });
    playRound1(game);
    game.startRound();
    expect(game.phase).toBe('PLAYING');
    expect(game.currentPlayer?.id).toBe('p1');
  });
});

describe('혁명', () => {
  // GP(좌석 3)가 광대 2장을 모두 든 라운드 2
  const REVOLUTION_HANDS: Card[][] = [
    [mkc('g1', 6), mkc('g2', 7)],
    [mkc('h1', 6), mkc('h2', 7)],
    [mkc('i1', 2), mkc('i2', 11)],
    [mkc('j-1', 13), mkc('j-2', 13)],
  ];

  function toRevolution(options: Partial<GameOptions> = {}): DalmutiGame {
    const game = makeGame([ROUND1_HANDS, REVOLUTION_HANDS], options);
    playRound1(game);
    game.startRound();
    return game;
  }

  it('광대 2장 소유자에게 혁명 선언 기회가 온다', () => {
    const game = toRevolution();
    expect(game.phase).toBe('REVOLUTION');
    expect(game.getRevolutionCandidateId()).toBe('p4');
  });

  it('다른 플레이어는 혁명을 선언할 수 없다', () => {
    const game = toRevolution();
    expect(() => game.declareRevolution('p1', true)).toThrowError(
      expect.objectContaining({ code: 'CANNOT_DECLARE_REVOLUTION' }),
    );
  });

  it('대농노의 선언은 대혁명: 계급이 역전되고 세금이 없다', () => {
    const game = toRevolution();
    game.declareRevolution('p4', true);
    expect(game.phase).toBe('PLAYING');
    const state = game.getPublicState();
    const byId = Object.fromEntries(state.players.map((p) => [p.id, p]));
    expect(byId.p4!.rank).toBe('GREATER_DALMUTI');
    expect(byId.p1!.rank).toBe('GREATER_PEON');
    expect(byId.p3!.rank).toBe('LESSER_DALMUTI');
    expect(byId.p2!.rank).toBe('LESSER_PEON');
    expect(game.currentPlayer?.id).toBe('p4'); // 새 대달무티가 리드
    expect(state.revolution).toMatchObject({ declaredById: 'p4', isGreat: true });
    // 세금이 걷히지 않았다: 손패 그대로 2장씩
    expect(game.getHandOf('p1')).toHaveLength(2);
  });

  it('선언을 포기하면 세금 단계로 넘어간다', () => {
    const game = toRevolution();
    game.declareRevolution('p4', false);
    expect(game.phase).toBe('TAXATION');
  });

  it('enableRevolution=false면 광대 2장을 들어도 세금으로 직행', () => {
    const game = toRevolution({ enableRevolution: false });
    expect(game.phase).toBe('TAXATION');
  });
});

describe('검토 반영: 상태 보호와 이벤트', () => {
  it('라운드 진행 중 startRound를 다시 호출하면 거부된다', () => {
    const game = makeGame([ROUND1_HANDS]);
    game.startRound();
    game.play('p1', ['a1']); // 진행 중
    expect(() => game.startRound()).toThrowError(
      expect.objectContaining({ code: 'WRONG_PHASE' }),
    );
  });

  it('getPublicState 스냅샷을 변조해도 엔진 내부가 오염되지 않는다', () => {
    const game = makeGame([ROUND1_HANDS], { targetRounds: 5 });
    game.startRound();
    const state = game.getPublicState();
    state.options.targetRounds = 1;
    state.players[0]!.handCount = 0;
    expect(game.options.targetRounds).toBe(5);
    expect(game.getPublicState().players[0]!.handCount).toBe(2);
  });

  it('혁명 대기 중 공개 상태에 후보자가 노출된다 (재접속 UI용)', () => {
    const REV_HANDS: Card[][] = [
      [mkc('g1', 6), mkc('g2', 7)],
      [mkc('h1', 6), mkc('h2', 7)],
      [mkc('i1', 2), mkc('i2', 11)],
      [mkc('j-1', 13), mkc('j-2', 13)],
    ];
    const game = makeGame([ROUND1_HANDS, REV_HANDS]);
    playRound1(game);
    game.startRound();
    expect(game.getPublicState().revolutionCandidateId).toBe('p4');
  });

  it('이벤트 로그: 플레이/완주/트릭 승리/라운드 종료가 기록되고 drain 후 비워진다', () => {
    const game = makeGame([ROUND1_HANDS]);
    playRound1(game);
    const events = game.drainEvents();
    const types = events.map((e) => e.type);
    expect(types).toContain('ROUND_STARTED');
    expect(types).toContain('PLAYED');
    expect(types).toContain('PLAYER_FINISHED');
    expect(types).toContain('ROUND_ENDED');
    expect(game.drainEvents()).toHaveLength(0);
  });

  it('세금 상납 이벤트에 카드 id가 기록된다 (서버 안내용)', () => {
    const R2: Card[][] = [
      [mkc('g1', 6), mkc('g2', 7), mkc('g3', 8)],
      [mkc('h1', 6), mkc('h2', 7), mkc('h3', 8)],
      [mkc('i1', 2), mkc('i2', 11), mkc('i3', 11)],
      [mkc('k1', 1), mkc('k2', 12), mkc('k3', 12)],
    ];
    const game = makeGame([ROUND1_HANDS, R2]);
    playRound1(game);
    game.drainEvents();
    game.startRound();
    const tributes = game
      .drainEvents()
      .filter((e) => e.type === 'TAX_TRIBUTE');
    expect(tributes).toHaveLength(2);
    expect(tributes[0]).toMatchObject({ fromId: 'p4', toId: 'p1', cardIds: ['k1', 'k2'] });
  });
});

describe('rankForPlace', () => {
  it('인원수에 맞는 계급 배정', () => {
    expect(rankForPlace(1, 6)).toBe('GREATER_DALMUTI');
    expect(rankForPlace(2, 6)).toBe('LESSER_DALMUTI');
    expect(rankForPlace(3, 6)).toBe('MERCHANT');
    expect(rankForPlace(4, 6)).toBe('MERCHANT');
    expect(rankForPlace(5, 6)).toBe('LESSER_PEON');
    expect(rankForPlace(6, 6)).toBe('GREATER_PEON');
    // 4인: 상인 없음
    expect(rankForPlace(3, 4)).toBe('LESSER_PEON');
  });
});
