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

/**
 * Thời gian tối đa được phép chỉnh sửa tin nhắn: 5 phút (300.000 ms).
 */
export const MESSAGE_EDIT_WINDOW_MS = 5 * 60 * 1000;

export interface CanEditMessageCandidate {
  authorId?: string | null;
  createdAt?: string | Date | null;
  deletedAt?: string | Date | null;
  type?: string | null;
  content?: string | null;
}

/**
 * Kiểm tra xem một tin nhắn có thỏa mãn điều kiện chỉnh sửa (trong vòng 5 phút) hay không.
 *
 * @param message Dữ liệu tin nhắn
 * @param currentUserId ID người dùng hiện tại
 * @param nowMs Mốc thời gian hiện tại (mili-giây, mặc định Date.now())
 * @returns boolean
 */
export function canEditMessage(
  message: CanEditMessageCandidate | null | undefined,
  currentUserId: string | null | undefined,
  nowMs: number = Date.now(),
): boolean {
  if (!message || !currentUserId) return false;
  if (message.authorId !== currentUserId) return false;
  if (message.deletedAt) return false;
  if (!message.createdAt) return false;

  const createdTime = new Date(message.createdAt).getTime();
  if (Number.isNaN(createdTime)) return false;

  // Điều kiện cho phép: serverNow < createdAt + MESSAGE_EDIT_WINDOW_MS
  // Tại đúng deadline hoặc sau deadline: hết hạn
  if (nowMs >= createdTime + MESSAGE_EDIT_WINDOW_MS) return false;

  // Loại tin nhắn có text body có thể chỉnh sửa:
  // Pure attachment không có text, system messages không thể edit
  if (
    message.type &&
    message.type !== 'text' &&
    message.type !== 'reply' &&
    message.type !== 'default'
  ) {
    return false;
  }

  return true;
}
