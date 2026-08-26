import { Module } from '@nestjs/common';
import { SupabaseAuthGuard } from '../../common/guards/supabase-auth.guard';
import { StorageModule } from '../../infra/storage/storage.module';
import { FriendsModule } from '../friends/friends.module';
import { ProfilesController } from './profiles.controller';
import { ProfilesService } from './profiles.service';

@Module({
  // FriendsModule: chỉ để đọc `getAcceptedFriendUserIds()` khi tính "bạn
  // chung" trên hồ sơ người khác — cùng kiểu tái dùng mà RealtimeModule đã
  // làm với PresenceService, không tự dựng lại logic đọc bảng `friendships`.
  imports: [StorageModule, FriendsModule],
  controllers: [ProfilesController],
  providers: [ProfilesService, SupabaseAuthGuard],
})
export class ProfilesModule {}
