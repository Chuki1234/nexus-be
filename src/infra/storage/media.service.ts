import {
  BadRequestException,
  Injectable,
  InternalServerErrorException,
  Logger,
  PayloadTooLargeException,
  UnsupportedMediaTypeException,
} from '@nestjs/common';
import sharp from 'sharp';
import { SupabaseService } from '../supabase/supabase.service';

/** Hai loại ảnh hồ sơ, mỗi loại một bucket và một khuôn kích thước riêng. */
export type ProfileImageKind = 'avatar' | 'banner';

interface ImagePreset {
  bucket: string;
  /** Tên file trong thư mục của user. Cố định để lần upload sau ghi đè lần trước. */
  objectName: string;
  width: number;
  height: number;
  quality: number;
}

const PRESETS: Record<ProfileImageKind, ImagePreset> = {
  // Vuông: mọi nơi hiển thị avatar đều bo tròn nên ảnh chữ nhật sẽ bị cắt lệch.
  avatar: {
    bucket: 'avatars',
    objectName: 'avatar.webp',
    width: 512,
    height: 512,
    quality: 82,
  },
  // 3:1 — tỉ lệ ảnh bìa của trang profile.
  banner: {
    bucket: 'banners',
    objectName: 'banner.webp',
    width: 1500,
    height: 500,
    quality: 80,
  },
};

/** Giới hạn file người dùng chọn. Ảnh sau khi nén luôn nhỏ hơn nhiều. */
export const MAX_UPLOAD_BYTES = 5 * 1024 * 1024;

/**
 * Định dạng nhận từ người dùng. Không tin `file.mimetype` (client tự khai) —
 * đây chỉ là bộ lọc thứ nhất, bộ lọc thật là sharp: file không phải ảnh sẽ ném
 * lỗi ngay ở bước đọc metadata.
 */
const ACCEPTED_MIME_TYPES = [
  'image/jpeg',
  'image/png',
  'image/webp',
  'image/gif',
  'image/avif',
];

/**
 * Chặn ảnh "bom giải nén": file vài chục KB nhưng khai báo kích thước khổng lồ,
 * đủ để làm cạn RAM khi decode. 50 MP vẫn thoải mái cho ảnh máy ảnh thật.
 */
const MAX_INPUT_PIXELS = 50_000_000;

/**
 * Nhận ảnh người dùng gửi lên, chuẩn hoá rồi đẩy vào Supabase Storage.
 *
 * Mọi ảnh đều được resize và chuyển sang webp trước khi upload, nên bucket chỉ
 * chứa file đúng kích thước, đúng định dạng, không còn metadata EXIF (sharp bỏ
 * metadata mặc định — tránh lộ toạ độ GPS trong ảnh chụp bằng điện thoại).
 */
@Injectable()
export class MediaService {
  private readonly logger = new Logger(MediaService.name);

  constructor(private readonly supabase: SupabaseService) {}

  /**
   * Trả về URL công khai của ảnh vừa upload.
   *
   * Đường dẫn file cố định theo user (`<userId>/avatar.webp`) nên lần upload sau
   * ghi đè lần trước — không cần dọn file cũ. Đổi lại URL không đổi, nên phải
   * gắn `?v=<epoch>` để trình duyệt và CDN không trả lại ảnh cũ trong cache.
   */
  async uploadProfileImage(
    kind: ProfileImageKind,
    userId: string,
    file: Express.Multer.File,
  ): Promise<string> {
    this.assertUploadable(file);

    const preset = PRESETS[kind];
    const optimized = await this.optimize(file.buffer, preset);
    const path = `${userId}/${preset.objectName}`;

    const { error } = await this.supabase.client.storage
      .from(preset.bucket)
      .upload(path, optimized, {
        contentType: 'image/webp',
        upsert: true,
        // Cache lâu là an toàn vì đã có `?v=` phá cache mỗi lần đổi ảnh.
        cacheControl: '31536000',
      });

    if (error) {
      this.logger.error(
        `Upload ${kind} thất bại (${userId}): ${error.message}`,
      );
      throw new InternalServerErrorException(
        'Không tải được ảnh lên. Vui lòng thử lại.',
      );
    }

    const { data } = this.supabase.client.storage
      .from(preset.bucket)
      .getPublicUrl(path);
    return `${data.publicUrl}?v=${Date.now()}`;
  }

  /**
   * Xoá ảnh khỏi bucket. Không ném lỗi khi file không tồn tại: người dùng chỉ
   * quan tâm hồ sơ hết ảnh, còn file rác trong bucket là chuyện của backend.
   */
  async removeProfileImage(
    kind: ProfileImageKind,
    userId: string,
  ): Promise<void> {
    const preset = PRESETS[kind];
    const { error } = await this.supabase.client.storage
      .from(preset.bucket)
      .remove([`${userId}/${preset.objectName}`]);

    if (error) {
      this.logger.warn(
        `Không xoá được ${kind} của ${userId}: ${error.message}`,
      );
    }
  }

  private assertUploadable(
    file: Express.Multer.File | undefined,
  ): asserts file {
    if (!file) {
      throw new BadRequestException('Chưa chọn ảnh để tải lên.');
    }
    if (file.size > MAX_UPLOAD_BYTES) {
      throw new PayloadTooLargeException(
        `Ảnh tối đa ${Math.floor(MAX_UPLOAD_BYTES / 1024 / 1024)} MB.`,
      );
    }
    if (!ACCEPTED_MIME_TYPES.includes(file.mimetype)) {
      throw new UnsupportedMediaTypeException(
        'Chỉ nhận ảnh JPEG, PNG, WebP, GIF hoặc AVIF.',
      );
    }
  }

  private async optimize(buffer: Buffer, preset: ImagePreset): Promise<Buffer> {
    try {
      return await sharp(buffer, {
        limitInputPixels: MAX_INPUT_PIXELS,
        // Mặc định `failOn: 'warning'` từ chối cả ảnh chỉ hơi sai chuẩn mà trình
        // duyệt vẫn mở được — quá gắt với ảnh người dùng tự chọn.
        failOn: 'error',
        // Ảnh động (GIF/WebP animated) chỉ lấy khung đầu: hồ sơ không cần animation
        // và giữ animation làm file phồng lên nhiều lần.
        pages: 1,
      })
        // Xoay theo EXIF Orientation TRƯỚC khi resize, nếu không ảnh chụp dọc từ
        // điện thoại sẽ bị cắt nhầm cạnh (metadata bị bỏ ở bước encode).
        .rotate()
        .resize(preset.width, preset.height, {
          fit: 'cover',
          position: 'centre',
          // Ảnh nhỏ hơn khung thì giữ nguyên, phóng to chỉ làm vỡ nét.
          withoutEnlargement: true,
        })
        .webp({ quality: preset.quality })
        .toBuffer();
    } catch (error) {
      // sharp ném ở đây khi file không phải ảnh thật, hoặc vượt limitInputPixels.
      this.logger.warn(`Xử lý ảnh thất bại: ${(error as Error).message}`);
      throw new BadRequestException(
        'Không đọc được ảnh này. Hãy thử ảnh khác.',
      );
    }
  }
}
