import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { APP_GUARD } from '@nestjs/core';
import { ThrottlerGuard, ThrottlerModule } from '@nestjs/throttler';
import { AppController } from './app.controller';
import { AppService } from './app.service';
import { SupabaseModule } from './infra/supabase/supabase.module';
import { AuthModule } from './modules/auth/auth.module';
import { ProfilesModule } from './modules/profiles/profiles.module';

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true }),
    // Trần chung, rộng tay — chỉ để chặn kiểu gọi loạn. Các route nhạy cảm tự
    // siết thêm bằng @Throttle (xem AuthController).
    ThrottlerModule.forRoot([{ ttl: 60_000, limit: 100 }]),
    SupabaseModule,
    AuthModule,
    ProfilesModule,
  ],
  controllers: [AppController],
  providers: [
    AppService,
    // Đếm theo IP. Khi deploy sau reverse proxy nhớ bật `trust proxy`, không thì
    // mọi request trông như đến từ cùng một IP và giới hạn sẽ chặn nhầm cả nhà.
    { provide: APP_GUARD, useClass: ThrottlerGuard },
  ],
})
export class AppModule {}
