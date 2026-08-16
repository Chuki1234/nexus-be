import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
// import { ConfigService } from '@nestjs/config'; // chỉ dùng trong factory của MongooseModule bên dưới
// import { MongooseModule } from '@nestjs/mongoose';
import { AppController } from './app.controller';
import { AppService } from './app.service';
import { SupabaseModule } from './infra/supabase/supabase.module';
import { AuthModule } from './modules/auth/auth.module';
// import { DrinkModule } from './modules/drink/drink.module';
import { ProfilesModule } from './modules/profiles/profiles.module';

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true }),
    /**
     * TẮT TẠM: MONGODB_URI trong .env vẫn còn nguyên placeholder
     * (`<user>:<pass>@<cluster>...`), nên MongooseModule cứ retry kết nối vô
     * hạn (`querySrv EBADNAME`) và không bao giờ khởi tạo xong. Vì nó nằm
     * trong `imports`, Nest bootstrap tuần tự — cả app (kể cả các module
     * Supabase/Auth/Profiles của Nexus, không liên quan gì tới Mongo) bị kẹt
     * theo, không module nào listen được ở cổng 3000.
     *
     * Bật lại bằng cách bỏ comment khối này VÀ dòng import DrinkModule ở trên,
     * sau khi đã dán MONGODB_URI thật (Mongo Atlas) vào nexus-be/.env.
     */
    // MongooseModule.forRootAsync({
    //   inject: [ConfigService],
    //   useFactory: (config: ConfigService) => {
    //     const uri = config.get<string>('MONGODB_URI');
    //     if (!uri) {
    //       throw new Error(
    //         'Thiếu MONGODB_URI trong .env — xem .env.example để biết định dạng.',
    //       );
    //     }
    //     return { uri };
    //   },
    // }),
    SupabaseModule,
    AuthModule,
    ProfilesModule,
    // DrinkModule,
  ],
  controllers: [AppController],
  providers: [AppService],
})
export class AppModule {}
