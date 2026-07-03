import { describe, expect, it } from 'vitest';
import { createBotStrategy, type BotView } from '../src/bots';
import { DalmutiGame } from '../src/game';
import { DEFAULT_GAME_OPTIONS, type BotDifficulty } from '../src/types';

/** 결정적 시드 rng (mulberry32) */
function mulberry32(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** 봇 4명이 targetRounds 라운드를 완주하는 풀 게임 시뮬레이션 → 좌석별 최종 점수 */
function playMatch(seats: BotDifficulty[], seed: number, targetRounds = 4): number[] {
  const rng = mulberry32(seed);
  const players = seats.map((d, i) => ({
    id: `bot${i}`,
    nickname: `bot${i}`,
    isBot: true,
    botDifficulty: d,
  }));
  const strategies = new Map(
    players.map((p, i) => [p.id, createBotStrategy(seats[i]!, rng)]),
  );
  const game = new DalmutiGame(players, {
    ...DEFAULT_GAME_OPTIONS,
    targetRounds,
  }, rng);

  const playedRankCounts: Record<number, number> = {};
  const consumeEvents = () => {
    for (const e of game.drainEvents()) {
      if (e.type === 'ROUND_STARTED') {
        for (const k of Object.keys(playedRankCounts)) delete playedRankCounts[Number(k)];
      } else if (e.type === 'PLAYED') {
        for (const c of e.cards) {
          playedRankCounts[c.rank] = (playedRankCounts[c.rank] ?? 0) + 1;
        }
      }
    }
  };

  const viewOf = (playerId: string): BotView => {
    const pub = game.getPublicState();
    return {
      myId: playerId,
      myRank: pub.players.find((p) => p.id === playerId)?.rank ?? null,
      hand: game.getHandOf(playerId),
      field: game.field,
      players: pub.players,
      playedRankCounts: { ...playedRankCounts },
    };
  };

  game.startRound();
  consumeEvents();

  for (let step = 0; step < 20000; step++) {
    if (game.phase === 'GAME_END') break;

    if (game.phase === 'ROUND_END') {
      game.startRound();
    } else if (game.phase === 'REVOLUTION') {
      const candidate = game.getRevolutionCandidateId()!;
      const declare = strategies.get(candidate)!.decideRevolution(viewOf(candidate));
      game.declareRevolution(candidate, declare);
    } else if (game.phase === 'TAXATION') {
      const pendingId = game.getPublicState().taxationPendingIds[0]!;
      const count = game.getPendingTaxReturn(pendingId)!.count;
      const ids = strategies.get(pendingId)!.decideTaxReturn(viewOf(pendingId), count);
      game.payTaxReturn(pendingId, ids);
    } else if (game.phase === 'PLAYING') {
      const current = game.currentPlayer!;
      const decision = strategies.get(current.id)!.decidePlay(viewOf(current.id));
      if (decision.type === 'play') {
        game.play(current.id, decision.cardIds);
      } else {
        game.pass(current.id);
      }
    }
    consumeEvents();
  }

  expect(game.phase).toBe('GAME_END');
  const pub = game.getPublicState();
  return players.map((p) => pub.players.find((x) => x.id === p.id)!.score);
}

describe('봇 전략이 규칙을 준수하며 게임을 완주한다', () => {
  it.each(['easy', 'normal', 'hard'] as const)('%s 봇 4명 풀 게임', (difficulty) => {
    for (let seed = 1; seed <= 5; seed++) {
      const scores = playMatch([difficulty, difficulty, difficulty, difficulty], seed);
      expect(scores).toHaveLength(4);
      // 4인 × n-place 점수: 라운드당 총합 = 3+2+1+0 = 6
      const total = scores.reduce((a, b) => a + b, 0);
      expect(total).toBe(6 * 4);
    }
  });
});

describe('난이도 서열 검증 (자동 대전)', () => {
  it('hard > normal > easy 평균 점수 서열이 유지된다', () => {
    // 좌석 편향을 없애기 위해 배치를 회전시키며 다수 대전
    const lineup: BotDifficulty[] = ['hard', 'normal', 'easy', 'easy'];
    const totals: Record<BotDifficulty, number> = { easy: 0, normal: 0, hard: 0 };
    const seatCounts: Record<BotDifficulty, number> = { easy: 0, normal: 0, hard: 0 };
    const MATCHES = 80;

    for (let m = 0; m < MATCHES; m++) {
      const rot = m % 4;
      const seats = [...lineup.slice(rot), ...lineup.slice(0, rot)];
      const scores = playMatch(seats, 1000 + m);
      seats.forEach((d, i) => {
        totals[d] += scores[i]!;
        seatCounts[d] += 1;
      });
    }

    const avg = (d: BotDifficulty) => totals[d] / seatCounts[d];
    // 서열 확인 (동률 방지를 위해 명확한 우위를 요구)
    expect(avg('hard')).toBeGreaterThan(avg('normal'));
    expect(avg('normal')).toBeGreaterThan(avg('easy'));
  }, 30000);
});
