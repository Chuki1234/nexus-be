import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Patch,
  Post,
  Query,
  UploadedFile,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import type { User } from '@supabase/supabase-js';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { SupabaseAuthGuard } from '../../common/guards/supabase-auth.guard';
import { MAX_UPLOAD_BYTES } from '../../infra/storage/media.service';
import { SearchProfilesDto } from './dto/search-profiles.dto';
import { UpdateProfileDto } from './dto/update-profile.dto';
import {
  OwnProfile,
  ProfileSummary,
  ProfilesService,
  PublicProfile,
} from './profiles.service';

/** Multer giữ file trong RAM (mặc định) — sharp cần Buffer, không cần file tạm. */
const UPLOAD_OPTIONS = { limits: { fileSize: MAX_UPLOAD_BYTES, files: 1 } };

/**
 * Toàn bộ endpoint đều yêu cầu đăng nhập: hồ sơ công khai trong phạm vi ứng dụng,
 * không công khai với cả internet.
 */
@Controller('profiles')
@UseGuards(SupabaseAuthGuard)
export class ProfilesController {
  constructor(private readonly profiles: ProfilesService) {}

  /** GET /api/profiles/me — hồ sơ của chính mình (có cả trường riêng tư). */
  @Get('me')
  getOwn(@CurrentUser() user: User): Promise<OwnProfile> {
    return this.profiles.getOwn(user.id);
  }

  /**
   * PATCH /api/profiles/me — sửa thông tin cá nhân, dòng trạng thái và link.
   * Ảnh đại diện / ảnh bìa đi đường riêng vì là multipart.
   */
  @Patch('me')
  update(
    @CurrentUser() user: User,
    @Body() dto: UpdateProfileDto,
  ): Promise<OwnProfile> {
    return this.profiles.update(user.id, dto);
  }

  /** POST /api/profiles/me/avatar — multipart, field `file`. */
  @Post('me/avatar')
  @UseInterceptors(FileInterceptor('file', UPLOAD_OPTIONS))
  uploadAvatar(
    @CurrentUser() user: User,
    @UploadedFile() file: Express.Multer.File,
  ): Promise<OwnProfile> {
    return this.profiles.setImage('avatar', user.id, file);
  }

  @Delete('me/avatar')
  removeAvatar(@CurrentUser() user: User): Promise<OwnProfile> {
    return this.profiles.removeImage('avatar', user.id);
  }

  /** POST /api/profiles/me/banner — multipart, field `file`. */
  @Post('me/banner')
  @UseInterceptors(FileInterceptor('file', UPLOAD_OPTIONS))
  uploadBanner(
    @CurrentUser() user: User,
    @UploadedFile() file: Express.Multer.File,
  ): Promise<OwnProfile> {
    return this.profiles.setImage('banner', user.id, file);
  }

  @Delete('me/banner')
  removeBanner(@CurrentUser() user: User): Promise<OwnProfile> {
    return this.profiles.removeImage('banner', user.id);
  }

  /**
   * GET /api/profiles/search?q=… — tìm người để mở hồ sơ của họ.
   * Phải khai báo trước `:username`, nếu không 'search' sẽ bị nuốt thành username.
   */
  @Get('search')
  search(
    @CurrentUser() user: User,
    @Query() query: SearchProfilesDto,
  ): Promise<ProfileSummary[]> {
    return this.profiles.search(query.q, user.id);
  }

  /** GET /api/profiles/:username — hồ sơ của người khác (hoặc của chính mình). */
  @Get(':username')
  getByUsername(
    @CurrentUser() user: User,
    @Param('username') username: string,
  ): Promise<PublicProfile> {
    return this.profiles.getByUsername(username, user.id);
  }
}
