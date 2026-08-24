import { validateDocxBuffer, createMockZipBuffer } from './docx-validator.util';

describe('DocxValidatorUtil (In-memory ZIP & OOXML Structure Validation)', () => {
  it('chấp nhận tài liệu DOCX hợp lệ chứa [Content_Types].xml và word/document.xml', () => {
    const buf = createMockZipBuffer([
      { name: '[Content_Types].xml', content: '<?xml version="1.0"?>' },
      { name: 'word/document.xml', content: '<w:document></w:document>' },
      { name: 'word/_rels/document.xml.rels', content: '<Relationships></Relationships>' },
    ]);

    const res = validateDocxBuffer(buf);
    expect(res.valid).toBe(true);
    expect(res.reason).toBeUndefined();
  });

  it('chuẩn hóa backslash trong tên entry (word\\document.xml) và chấp nhận tệp', () => {
    const buf = createMockZipBuffer([
      { name: '[Content_Types].xml', content: '<?xml version="1.0"?>' },
      { name: 'word\\document.xml', content: '<w:document></w:document>' },
    ]);

    const res = validateDocxBuffer(buf);
    expect(res.valid).toBe(true);
  });

  it('từ chối khi thiếu word/document.xml (file ZIP thông thường đổi đuôi .docx)', () => {
    const buf = createMockZipBuffer([
      { name: '[Content_Types].xml', content: '<?xml version="1.0"?>' },
      { name: 'sheet.xml', content: '<data></data>' },
    ]);

    const res = validateDocxBuffer(buf);
    expect(res.valid).toBe(false);
    expect(res.reason).toContain('thiếu [Content_Types].xml hoặc word/document.xml');
  });

  it('từ chối khi thiếu [Content_Types].xml', () => {
    const buf = createMockZipBuffer([
      { name: 'word/document.xml', content: '<w:document></w:document>' },
    ]);

    const res = validateDocxBuffer(buf);
    expect(res.valid).toBe(false);
    expect(res.reason).toContain('thiếu [Content_Types].xml hoặc word/document.xml');
  });

  it('từ chối tệp ZIP bị mã hóa mật khẩu (Bit 0 Encrypted flag set)', () => {
    const buf = createMockZipBuffer([
      { name: '[Content_Types].xml', content: '<?xml version="1.0"?>' },
      { name: 'word/document.xml', content: '<w:document></w:document>', encrypted: true },
    ]);

    const res = validateDocxBuffer(buf);
    expect(res.valid).toBe(false);
    expect(res.reason).toContain('mã hóa mật khẩu');
  });

  it('từ chối định dạng ZIP64', () => {
    const buf = createMockZipBuffer(
      [
        { name: '[Content_Types].xml', content: '<?xml version="1.0"?>' },
        { name: 'word/document.xml', content: '<w:document></w:document>' },
      ],
      { zip64Signature: true },
    );

    const res = validateDocxBuffer(buf);
    expect(res.valid).toBe(false);
    expect(res.reason).toContain('ZIP64');
  });

  it('từ chối định dạng multi-disk ZIP', () => {
    const buf = createMockZipBuffer(
      [
        { name: '[Content_Types].xml', content: '<?xml version="1.0"?>' },
        { name: 'word/document.xml', content: '<w:document></w:document>' },
      ],
      { diskNumber: 1 },
    );

    const res = validateDocxBuffer(buf);
    expect(res.valid).toBe(false);
    expect(res.reason).toContain('multi-disk ZIP');
  });

  it('từ chối khi offset Central Directory bị hỏng vượt quá kích thước buffer', () => {
    const buf = createMockZipBuffer(
      [
        { name: '[Content_Types].xml', content: '<?xml version="1.0"?>' },
        { name: 'word/document.xml', content: '<w:document></w:document>' },
      ],
      { corruptCdOffset: true },
    );

    const res = validateDocxBuffer(buf);
    expect(res.valid).toBe(false);
    expect(res.reason).toContain('Offset Central Directory');
  });

  it('từ chối entry bất thường có compressedSize = 0 nhưng uncompressedSize > 0', () => {
    const buf = createMockZipBuffer([
      { name: '[Content_Types].xml', content: '<?xml version="1.0"?>' },
      {
        name: 'word/document.xml',
        content: '<w:document></w:document>',
        compressedSize: 0,
        uncompressedSize: 1000,
      },
    ]);

    const res = validateDocxBuffer(buf);
    expect(res.valid).toBe(false);
    expect(res.reason).toContain('kích thước nén bằng 0');
  });

  it('từ chối entry chứa path traversal (segment ..)', () => {
    const buf = createMockZipBuffer([
      { name: '[Content_Types].xml', content: '<?xml version="1.0"?>' },
      { name: 'word/../../etc/passwd', content: 'traversal' },
    ]);

    const res = validateDocxBuffer(buf);
    expect(res.valid).toBe(false);
    expect(res.reason).toContain('path traversal');
  });

  it('không chặn nhầm tên file hợp lệ chứa 2 dấu chấm (vd: word/document.final.xml)', () => {
    const buf = createMockZipBuffer([
      { name: '[Content_Types].xml', content: '<?xml version="1.0"?>' },
      { name: 'word/document.xml', content: '<w:document></w:document>' },
      { name: 'word/document.final.xml', content: '<w:document></w:document>' },
    ]);

    const res = validateDocxBuffer(buf);
    expect(res.valid).toBe(true);
  });

  it('từ chối entry chứa ký tự NUL', () => {
    const buf = createMockZipBuffer([
      { name: '[Content_Types].xml', content: '<?xml version="1.0"?>' },
      { name: 'word/document\x00.xml', content: 'bad' },
    ]);

    const res = validateDocxBuffer(buf);
    expect(res.valid).toBe(false);
    expect(res.reason).toContain('NUL');
  });

  it('từ chối entry chứa Windows drive path (C:/file.xml)', () => {
    const buf = createMockZipBuffer([
      { name: '[Content_Types].xml', content: '<?xml version="1.0"?>' },
      { name: 'C:/word/document.xml', content: 'bad' },
    ]);

    const res = validateDocxBuffer(buf);
    expect(res.valid).toBe(false);
    expect(res.reason).toContain('đường dẫn ổ đĩa tuyệt đối');
  });

  it('từ chối ZIP bomb có tỷ lệ nén entry vượt quá 100:1', () => {
    const buf = createMockZipBuffer([
      { name: '[Content_Types].xml', content: '<?xml version="1.0"?>' },
      {
        name: 'word/document.xml',
        content: 'a',
        compressedSize: 10,
        uncompressedSize: 2000, // 200:1 ratio
      },
    ]);

    const res = validateDocxBuffer(buf);
    expect(res.valid).toBe(false);
    expect(res.reason).toContain('Tỷ lệ nén của entry vượt quá giới hạn an toàn');
  });

  it('từ chối ZIP bomb có tổng dung lượng uncompressed vượt quá 50MB', () => {
    const buf = createMockZipBuffer([
      { name: '[Content_Types].xml', content: '<?xml version="1.0"?>' },
      {
        name: 'word/document.xml',
        content: 'a',
        compressedSize: 600 * 1024,
        uncompressedSize: 51 * 1024 * 1024, // 51MB
      },
    ]);

    const res = validateDocxBuffer(buf);
    expect(res.valid).toBe(false);
    expect(res.reason).toContain('vượt quá giới hạn 50MB');
  });
});
