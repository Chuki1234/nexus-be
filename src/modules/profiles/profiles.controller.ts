import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Patch,
  Post,
  Put,
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
import { SetBirthdateDto } from './dto/set-birthdate.dto';
import { SetProfileNoteDto } from './dto/set-profile-note.dto';
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

  /**
   * PUT /api/profiles/me/birthdate — đổi ngày sinh. Đường riêng, không nằm
   * trong PATCH /me (xem ghi chú ở `UpdateProfileDto`).
   */
  @Put('me/birthdate')
  setBirthdate(
    @CurrentUser() user: User,
    @Body() dto: SetBirthdateDto,
  ): Promise<OwnProfile> {
    return this.profiles.setBirthdate(user.id, dto.birthdate);
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

  /**
   * GET /api/profiles/:username/note — ghi chú RIÊNG của người xem về người
   * này. Không lẫn vào response của `:username` vì đây là dữ liệu của người
   * xem, không phải của chủ hồ sơ — hai người cùng xem một hồ sơ sẽ thấy hai
   * ghi chú khác nhau.
   */
  @Get(':username/note')
  getNote(
    @CurrentUser() user: User,
    @Param('username') username: string,
  ): Promise<{ text: string }> {
    return this.profiles.getNote(username, user.id);
  }

  /** PUT /api/profiles/:username/note — lưu ghi chú, gửi chuỗi rỗng để xoá. */
  @Put(':username/note')
  setNote(
    @CurrentUser() user: User,
    @Param('username') username: string,
    @Body() dto: SetProfileNoteDto,
  ): Promise<{ text: string }> {
    return this.profiles.setNote(username, user.id, dto.text);
  }
}
