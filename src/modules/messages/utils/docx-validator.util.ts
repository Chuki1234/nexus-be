/**
 * Bộ xác thực định dạng DOCX in-memory an toàn (Không phải malware scanner).
 * Xác minh cấu trúc OOXML (ZIP container) và phòng chống archive bất thường / ZIP bomb.
 */

export interface DocxValidationResult {
  valid: boolean;
  reason?: string;
}

export function createMockZipBuffer(
  entries: {
    name: string;
    content?: string;
    encrypted?: boolean;
    compressedSize?: number;
    uncompressedSize?: number;
  }[],
  options?: {
    diskNumber?: number;
    startDisk?: number;
    zip64Signature?: boolean;
    corruptCdOffset?: boolean;
    corruptCdSize?: boolean;
    eocdTotalEntries?: number;
  },
): Buffer {
  const localHeaders: Buffer[] = [];
  const cdRecords: Buffer[] = [];
  let offset = 0;

  for (const entry of entries) {
    const nameBuf = Buffer.from(entry.name, 'utf8');
    const contentBuf = Buffer.from(entry.content || '<xml></xml>', 'utf8');
    const uncompressedSize =
      entry.uncompressedSize !== undefined ? entry.uncompressedSize : contentBuf.length;
    const compressedSize =
      entry.compressedSize !== undefined ? entry.compressedSize : contentBuf.length;
    const flags = entry.encrypted ? 1 : 0;

    // Local file header: 30 bytes + name + content
    const lh = Buffer.alloc(30 + nameBuf.length + contentBuf.length);
    lh.writeUInt32LE(0x04034b50, 0); // PK\x03\x04
    lh.writeUInt16LE(20, 4); // version needed
    lh.writeUInt16LE(flags, 6); // flags
    lh.writeUInt16LE(0, 8); // compression method (0 = store)
    lh.writeUInt32LE(0, 10); // time/date
    lh.writeUInt32LE(0, 14); // crc32
    lh.writeUInt32LE(compressedSize, 18);
    lh.writeUInt32LE(uncompressedSize, 22);
    lh.writeUInt16LE(nameBuf.length, 26);
    lh.writeUInt16LE(0, 28); // extra field len
    nameBuf.copy(lh, 30);
    contentBuf.copy(lh, 30 + nameBuf.length);

    localHeaders.push(lh);

    // Central directory header: 46 bytes + name
    const cd = Buffer.alloc(46 + nameBuf.length);
    cd.writeUInt32LE(0x02014b50, 0); // PK\x01\x02
    cd.writeUInt16LE(20, 4); // version made by
    cd.writeUInt16LE(20, 6); // version needed
    cd.writeUInt16LE(flags, 8); // flags
    cd.writeUInt16LE(0, 10); // method
    cd.writeUInt32LE(0, 12); // time/date
    cd.writeUInt32LE(0, 16); // crc32
    cd.writeUInt32LE(compressedSize, 20);
    cd.writeUInt32LE(uncompressedSize, 24);
    cd.writeUInt16LE(nameBuf.length, 28);
    cd.writeUInt16LE(0, 30); // extra len
    cd.writeUInt16LE(0, 32); // comment len
    cd.writeUInt16LE(0, 34); // disk start
    cd.writeUInt16LE(0, 36); // internal attr
    cd.writeUInt32LE(0, 38); // external attr
    cd.writeUInt32LE(offset, 42); // local header offset
    nameBuf.copy(cd, 46);

    cdRecords.push(cd);
    offset += lh.length;
  }

  const localHeadersBuf = Buffer.concat(localHeaders);
  const cdBuf = Buffer.concat(cdRecords);

  const cdOffset = options?.corruptCdOffset ? 999999 : localHeadersBuf.length;
  const cdSize = options?.corruptCdSize ? 999999 : cdBuf.length;
  const totalEntries =
    options?.eocdTotalEntries !== undefined ? options.eocdTotalEntries : entries.length;

  // EOCD: 22 bytes
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0); // PK\x05\x06
  eocd.writeUInt16LE(options?.diskNumber ?? 0, 4);
  eocd.writeUInt16LE(options?.startDisk ?? 0, 6);
  eocd.writeUInt16LE(totalEntries, 8); // entries on disk
  eocd.writeUInt16LE(totalEntries, 10); // total entries
  eocd.writeUInt32LE(cdSize, 12);
  eocd.writeUInt32LE(cdOffset, 16);
  eocd.writeUInt16LE(0, 20); // comment len

  let result = Buffer.concat([localHeadersBuf, cdBuf, eocd]);

  if (options?.zip64Signature) {
    const zip64Marker = Buffer.from([0x50, 0x4b, 0x06, 0x06]);
    result = Buffer.concat([result, zip64Marker]);
  }

  return result;
}

const MAX_ENTRIES = 1000;
const MAX_TOTAL_UNCOMPRESSED_BYTES = 50 * 1024 * 1024; // 50MB
const MAX_COMPRESSION_RATIO = 100; // 100:1

export function validateDocxBuffer(buffer: Buffer): DocxValidationResult {
  if (!buffer || buffer.length < 22) {
    return { valid: false, reason: 'Dung lượng tệp quá nhỏ không phải định dạng DOCX/ZIP hợp lệ.' };
  }

  // 1. Kiểm tra magic bytes cơ bản PK\x03\x04 ở đầu buffer
  if (
    buffer[0] !== 0x50 ||
    buffer[1] !== 0x4b ||
    buffer[2] !== 0x03 ||
    buffer[3] !== 0x04
  ) {
    return { valid: false, reason: 'Tệp không bắt đầu bằng signature ZIP PK\\x03\\x04.' };
  }

  // 2. Từ chối ZIP64 indicators
  if (
    buffer.includes(Buffer.from([0x50, 0x4b, 0x06, 0x06])) ||
    buffer.includes(Buffer.from([0x50, 0x4b, 0x06, 0x07]))
  ) {
    return { valid: false, reason: 'Không hỗ trợ định dạng ZIP64 trong tài liệu DOCX.' };
  }

  // 3. Tìm End of Central Directory Record (EOCD: PK\x05\x06)
  // EOCD có kích thước tối thiểu 22 bytes, tối đa 22 + 65535 (comment)
  let eocdOffset = -1;
  const searchStart = buffer.length - 22;
  const searchEnd = Math.max(0, buffer.length - 65557);

  for (let i = searchStart; i >= searchEnd; i--) {
    if (
      buffer[i] === 0x50 &&
      buffer[i + 1] === 0x4b &&
      buffer[i + 2] === 0x05 &&
      buffer[i + 3] === 0x06
    ) {
      eocdOffset = i;
      break;
    }
  }

  if (eocdOffset === -1) {
    return { valid: false, reason: 'Không tìm thấy cấu trúc End of Central Directory (EOCD).' };
  }

  // Đọc các trường EOCD
  const diskNumber = buffer.readUInt16LE(eocdOffset + 4);
  const startDisk = buffer.readUInt16LE(eocdOffset + 6);
  const totalEntries = buffer.readUInt16LE(eocdOffset + 10);
  const centralDirSize = buffer.readUInt32LE(eocdOffset + 12);
  const centralDirOffset = buffer.readUInt32LE(eocdOffset + 16);

  // Từ chối multi-disk ZIP
  if (diskNumber !== 0 || startDisk !== 0) {
    return { valid: false, reason: 'Không hỗ trợ định dạng multi-disk ZIP.' };
  }

  // Từ chối ZIP64 indicators trong EOCD
  if (
    totalEntries === 0xffff ||
    centralDirSize === 0xffffffff ||
    centralDirOffset === 0xffffffff
  ) {
    return { valid: false, reason: 'Không hỗ trợ định dạng ZIP64 trong tài liệu DOCX.' };
  }

  // Kiểm tra giới hạn Central Directory Offset và Size trong buffer
  if (
    centralDirOffset + centralDirSize > eocdOffset ||
    centralDirOffset + centralDirSize > buffer.length ||
    centralDirOffset < 0
  ) {
    return { valid: false, reason: 'Offset Central Directory bị hỏng hoặc vượt ngoài giới hạn tệp.' };
  }

  // 4. Duyệt các bản ghi Central Directory Header (PK\x01\x02)
  let cdOffset = centralDirOffset;
  const cdEnd = centralDirOffset + centralDirSize;
  const entries = new Set<string>();
  let totalUncompressedSize = 0;
  let entryCount = 0;

  while (cdOffset < cdEnd) {
    if (cdOffset + 46 > cdEnd) {
      return { valid: false, reason: 'Bản ghi Central Directory bị cắt cụt.' };
    }

    if (
      buffer[cdOffset] !== 0x50 ||
      buffer[cdOffset + 1] !== 0x4b ||
      buffer[cdOffset + 2] !== 0x01 ||
      buffer[cdOffset + 3] !== 0x02
    ) {
      return { valid: false, reason: 'Signature Central Directory Header không hợp lệ.' };
    }

    const flags = buffer.readUInt16LE(cdOffset + 8);
    // Bit 0: Encrypted
    if ((flags & 0x0001) !== 0) {
      return { valid: false, reason: 'Tài liệu DOCX bị mã hóa mật khẩu, không được hỗ trợ.' };
    }

    const compressedSize = buffer.readUInt32LE(cdOffset + 20);
    const uncompressedSize = buffer.readUInt32LE(cdOffset + 24);

    if (compressedSize === 0xffffffff || uncompressedSize === 0xffffffff) {
      return { valid: false, reason: 'Không hỗ trợ định dạng ZIP64.' };
    }

    // Từ chối entry bất thường: compressedSize = 0 nhưng uncompressedSize > 0
    if (compressedSize === 0 && uncompressedSize > 0) {
      return { valid: false, reason: 'Entry có kích thước nén bằng 0 nhưng uncompressedSize > 0.' };
    }

    // Kiểm tra tỷ lệ nén (Compression Ratio) từng entry
    if (compressedSize > 0) {
      const entryRatio = uncompressedSize / compressedSize;
      if (entryRatio > MAX_COMPRESSION_RATIO) {
        return { valid: false, reason: `Tỷ lệ nén của entry vượt quá giới hạn an toàn (${Math.round(entryRatio)}:1).` };
      }
    }

    // Cộng dồn và kiểm tra tổng uncompressed size ngay trong vòng lặp
    totalUncompressedSize += uncompressedSize;
    if (totalUncompressedSize > MAX_TOTAL_UNCOMPRESSED_BYTES) {
      return { valid: false, reason: 'Tổng dung lượng giải nén vượt quá giới hạn 50MB (nguy cơ ZIP bomb).' };
    }

    entryCount++;
    if (entryCount > MAX_ENTRIES) {
      return { valid: false, reason: `Số lượng entry vượt quá giới hạn cho phép (${MAX_ENTRIES}).` };
    }

    const nameLen = buffer.readUInt16LE(cdOffset + 28);
    const extraLen = buffer.readUInt16LE(cdOffset + 30);
    const commentLen = buffer.readUInt16LE(cdOffset + 32);

    const entryTotalLen = 46 + nameLen + extraLen + commentLen;
    if (cdOffset + entryTotalLen > cdEnd) {
      return { valid: false, reason: 'Entry Central Directory vượt quá phạm vi bảng.' };
    }

    const rawName = buffer.toString('utf8', cdOffset + 46, cdOffset + 46 + nameLen);

    // Từ chối ký tự NUL
    if (rawName.includes('\x00')) {
      return { valid: false, reason: 'Tên entry chứa ký tự NUL không hợp lệ.' };
    }

    // Chuẩn hóa \ thành /
    const normalizedName = rawName.replace(/\\/g, '/');

    // Từ chối Windows drive path (C:/)
    if (/^[a-zA-Z]:/.test(normalizedName)) {
      return { valid: false, reason: 'Entry chứa đường dẫn ổ đĩa tuyệt đối.' };
    }

    // Từ chối root path (/...)
    if (normalizedName.startsWith('/')) {
      return { valid: false, reason: 'Entry chứa đường dẫn root tuyệt đối.' };
    }

    // Từ chối path traversal chính xác (segment '..')
    const segments = normalizedName.split('/');
    if (segments.some((seg) => seg === '..')) {
      return { valid: false, reason: 'Entry chứa path traversal (..).' };
    }

    entries.add(normalizedName);
    cdOffset += entryTotalLen;
  }

  // 5. Kiểm tra tính toàn vẹn của cấu trúc OOXML
  const hasContentTypes = entries.has('[Content_Types].xml');
  const hasWordDocument = entries.has('word/document.xml');

  if (!hasContentTypes || !hasWordDocument) {
    return {
      valid: false,
      reason: 'Tệp không phải là tài liệu Word (.docx) hợp lệ: thiếu [Content_Types].xml hoặc word/document.xml.',
    };
  }

  return { valid: true };
}
