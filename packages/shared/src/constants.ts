export const JESTER_RANK = 13;
export const MIN_RANK = 1;
export const MAX_RANK = 12;
export const JESTER_COUNT = 2;
/** 1+2+...+MAX_RANK + 광대 = 80장. 상수 튜닝 시에도 어긋나지 않게 계산식으로 유지 */
export const TOTAL_CARDS = (MAX_RANK * (MAX_RANK + 1)) / 2 + JESTER_COUNT;

export const MIN_PLAYERS = 4;
/** 정식 룰은 4~8인이지만 80장 덱으로 10인(인당 8장)까지 무리 없이 동작한다 */
export const MAX_PLAYERS = 10;

export const MAX_CHAT_LENGTH = 200;
export const CHAT_HISTORY_LIMIT = 100;

/**
 * 클라-서버 프로토콜 버전. 이벤트/페이로드가 호환되지 않게 바뀔 때 올린다.
 * 서버는 접속 직후 server:hello로 자신의 버전을 알리고, 구버전 번들을 캐시한
 * 클라이언트는 이를 비교해 "새로고침" 안내를 띄운다 (배포 중 버전 스큐 대응).
 */
export const PROTOCOL_VERSION = 2;

export const RANK_NAMES_KO: Record<number, string> = {
  1: '달무티',
  2: '대주교',
  3: '시종장',
  4: '남작부인',
  5: '수녀원장',
  6: '기사',
  7: '재봉사',
  8: '석공',
  9: '요리사',
  10: '양치기',
  11: '광부',
  12: '농노',
  13: '광대',
};
