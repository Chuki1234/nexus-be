import { Logger, ValidationPipe } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';
import { RedisIoAdapter } from './common/adapters/redis-io.adapter';
import { normalizeCorsOrigins } from './common/utils/cors.util';

async function bootstrap() {
  const logger = new Logger('Bootstrap');
  const app = await NestFactory.create(AppModule);

  app.enableShutdownHooks();

  // Frontend gọi http://localhost:3000/api/...
  app.setGlobalPrefix('api');

  app.useGlobalPipes(
    new ValidationPipe({
      // Cắt bỏ field lạ và từ chối request chứa chúng — không ai chèn thêm được
      // thuộc tính vào DTO để đi vòng qua validate.
      whitelist: true,
      forbidNonWhitelisted: true,
      // Bật để @Transform trong DTO thực sự chạy (trim, lowercase).
      transform: true,
      // Mỗi field chỉ trả một câu. Không bật thì bỏ trống ô mật khẩu sẽ nhận cả
      // "Vui lòng nhập mật khẩu." lẫn "Mật khẩu tối đa 72 ký tự." — câu thứ hai
      // vô nghĩa với ô đang để trống.
      stopAtFirstError: true,
    }),
  );

  const isDistributed = process.env.REALTIME_DISTRIBUTED === 'true';
  const redisUrl = process.env.REDIS_URL;
  const keyPrefix = process.env.REDIS_KEY_PREFIX || 'nexuscord:dev:';

  if (isDistributed || redisUrl) {
    if (!redisUrl) {
      throw new Error(
        'Lỗi cấu hình: REALTIME_DISTRIBUTED=true yêu cầu biến môi trường REDIS_URL hợp lệ',
      );
    }
    try {
      const redisIoAdapter = new RedisIoAdapter(app);
      await redisIoAdapter.connectToRedis(redisUrl, keyPrefix);
      app.useWebSocketAdapter(redisIoAdapter);
      logger.log(`Đã kết nối Socket.IO Redis Adapter tại prefix: ${keyPrefix}`);
    } catch (err: any) {
      logger.error(
        `Không thể kết nối Redis Socket.IO Adapter: ${err.message}`,
        err.stack,
      );
      if (isDistributed) {
        throw new Error(
          `Fail-fast bootstrap: Không thể kết nối Redis tại ${redisUrl} (${err.message})`,
        );
      }
    }
  }

  const allowedOrigins = normalizeCorsOrigins(process.env.CORS_ORIGINS);

  app.enableCors({
    origin: (origin, callback) => {
      // Cho phép request không có origin (server-to-server, curl, Postman)
      // hoặc origin trùng khớp sau khi chuẩn hóa
      if (!origin || allowedOrigins.includes(origin.replace(/\/+$/, ''))) {
        callback(null, true);
      } else {
        callback(new Error(`Origin ${origin} is not allowed by CORS`));
      }
    },
    credentials: true,
    methods: ['GET', 'HEAD', 'PUT', 'PATCH', 'POST', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Authorization', 'Content-Type', 'Accept'],
  });

  await app.listen(process.env.PORT ?? 3000);
}
void bootstrap();
