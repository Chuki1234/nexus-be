/**
 * Hợp đồng dữ liệu đa phương tiện bên ngoài (External Media / GIPHY).
 *
 * File này được nhân bản y hệt ở nexus-fe/src/shared/dto/messages.dto.ts.
 * Kiểm tra tính nhất quán bằng `npm run check:shared`.
 */

export type ExternalMediaProvider = 'giphy';
export type ExternalMediaType = 'gif';

export interface GiphyMediaDto {
  provider: ExternalMediaProvider;
  externalId: string;
  mediaType: ExternalMediaType;
  title: string;
  creatorUsername: string | null;
  pageUrl: string;
  previewUrl: string;
  displayUrl: string;
  mp4Url: string | null;
  width: number;
  height: number;
}
