import { createGameServer } from './server';

const PORT = Number(process.env.PORT ?? 3001);
const { httpServer, close } = createGameServer();

httpServer.listen(PORT, () => {
  console.log(`[dalmuti] 게임 서버가 :${PORT} 에서 대기 중`);
});

let shuttingDown = false;
for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log(`[dalmuti] ${signal} 수신, 서버를 종료합니다`);
    // 소켓을 먼저 끊어야 httpServer.close 콜백이 실제로 실행된다
    void close().then(() => {
      httpServer.close(() => process.exit(0));
    });
    // 어떤 이유로든 5초 내에 안 끝나면 강제 종료
    setTimeout(() => process.exit(0), 5000).unref();
  });
}
