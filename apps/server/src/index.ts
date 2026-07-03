import { createGameServer } from './server';

const PORT = Number(process.env.PORT ?? 3001);
const { httpServer } = createGameServer();

httpServer.listen(PORT, () => {
  console.log(`[dalmuti] 게임 서버가 :${PORT} 에서 대기 중`);
});

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => {
    console.log(`[dalmuti] ${signal} 수신, 서버를 종료합니다`);
    httpServer.close(() => process.exit(0));
    // 소켓이 열려있어도 5초 후 강제 종료
    setTimeout(() => process.exit(0), 5000).unref();
  });
}
