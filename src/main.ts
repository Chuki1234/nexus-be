import { ValidationPipe } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';

async function bootstrap() {
  const app = await NestFactory.create(AppModule);

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
    }),
  );

  app.enableCors({
    origin: (process.env.CORS_ORIGINS ?? 'http://localhost:4200').split(','),
  });

  await app.listen(process.env.PORT ?? 3000);
}
void bootstrap();
