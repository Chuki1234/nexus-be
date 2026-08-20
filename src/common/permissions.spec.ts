import {
  ALL_PERMISSIONS,
  computeEffectivePermissions,
  DEFAULT_EVERYONE_PERMISSIONS,
  hasPermission,
  Permission,
} from '../shared/permissions';

/**
 * Test đặt ngoài `shared/` vì hai repo dùng hai bộ chạy test khác nhau
 * (jest ở backend, vitest ở frontend) — để file .spec trong shared sẽ làm hỏng
 * một trong hai.
 */
describe('permissions bitfield', () => {
  it('ADMINISTRATOR không bị toán tử 32-bit làm hỏng', () => {
    // Cạm bẫy: với `number` thì `1 << 62` ra đúng bằng `1 << 30`, khiến
    // ADMINISTRATOR trùng bit với một quyền khác.
    expect(Permission.ADMINISTRATOR).toBe(4611686018427387904n);
    expect(Permission.ADMINISTRATOR).not.toBe(BigInt(1 << 30));
  });

  it('quyền mặc định của @everyone khớp con số trong hàm SQL', () => {
    // create_default_role() hardcode 3339. Lệch là server mới sinh ra sai quyền.
    expect(DEFAULT_EVERYONE_PERMISSIONS).toBe(3339n);
  });

  it('mỗi quyền chiếm một bit riêng', () => {
    const bits = Object.values(Permission);
    const combined = bits.reduce((all, bit) => all | bit, 0n);
    const sum = bits.reduce((total, bit) => total + bit, 0n);
    expect(combined).toBe(sum);
  });
});

describe('computeEffectivePermissions', () => {
  it('gộp quyền của mọi role bằng OR', () => {
    const perms = computeEffectivePermissions({
      rolePermissions: [Permission.VIEW_CHANNEL, Permission.SEND_MESSAGES],
    });

    expect(hasPermission(perms, Permission.VIEW_CHANNEL)).toBe(true);
    expect(hasPermission(perms, Permission.SEND_MESSAGES)).toBe(true);
    expect(hasPermission(perms, Permission.KICK_MEMBERS)).toBe(false);
  });

  it('ADMINISTRATOR bỏ qua cả overwrite deny', () => {
    const perms = computeEffectivePermissions({
      rolePermissions: [Permission.ADMINISTRATOR],
      everyoneOverwrite: { allow: 0n, deny: Permission.SEND_MESSAGES },
      memberOverwrite: { allow: 0n, deny: Permission.VIEW_CHANNEL },
    });

    expect(perms).toBe(ALL_PERMISSIONS);
    expect(hasPermission(perms, Permission.SEND_MESSAGES)).toBe(true);
    expect(hasPermission(perms, Permission.VIEW_CHANNEL)).toBe(true);
  });

  it('trong cùng một bước, allow thắng deny', () => {
    const perms = computeEffectivePermissions({
      rolePermissions: [0n],
      everyoneOverwrite: {
        allow: Permission.SEND_MESSAGES,
        deny: Permission.SEND_MESSAGES,
      },
    });

    expect(hasPermission(perms, Permission.SEND_MESSAGES)).toBe(true);
  });

  it('overwrite của member áp SAU role, nên gỡ được lệnh cấm của role', () => {
    // Đây là lý do thứ tự không được đổi: một overwrite cấp cá nhân phải cứu
    // được người bị role cấm.
    const perms = computeEffectivePermissions({
      rolePermissions: [Permission.VIEW_CHANNEL | Permission.SEND_MESSAGES],
      roleOverwrites: [{ allow: 0n, deny: Permission.SEND_MESSAGES }],
      memberOverwrite: { allow: Permission.SEND_MESSAGES, deny: 0n },
    });

    expect(hasPermission(perms, Permission.SEND_MESSAGES)).toBe(true);
  });

  it('overwrite của role áp SAU @everyone, nên gỡ được lệnh cấm chung', () => {
    const perms = computeEffectivePermissions({
      rolePermissions: [Permission.VIEW_CHANNEL],
      everyoneOverwrite: { allow: 0n, deny: Permission.VIEW_CHANNEL },
      roleOverwrites: [{ allow: Permission.VIEW_CHANNEL, deny: 0n }],
    });

    expect(hasPermission(perms, Permission.VIEW_CHANNEL)).toBe(true);
  });

  it('member deny thắng role allow — chiều ngược lại vẫn đúng', () => {
    const perms = computeEffectivePermissions({
      rolePermissions: [Permission.VIEW_CHANNEL],
      roleOverwrites: [{ allow: Permission.SEND_MESSAGES, deny: 0n }],
      memberOverwrite: { allow: 0n, deny: Permission.SEND_MESSAGES },
    });

    expect(hasPermission(perms, Permission.SEND_MESSAGES)).toBe(false);
  });

  it('không có overwrite nào thì giữ nguyên quyền gốc', () => {
    const base = Permission.VIEW_CHANNEL | Permission.CONNECT_VOICE;
    expect(computeEffectivePermissions({ rolePermissions: [base] })).toBe(base);
  });

  it('không có role nào thì không có quyền gì', () => {
    expect(computeEffectivePermissions({ rolePermissions: [] })).toBe(0n);
  });
});

describe('hasPermission', () => {
  it('yêu cầu nhiều quyền thì phải có ĐỦ, không phải có một trong số đó', () => {
    const perms = Permission.VIEW_CHANNEL;
    const needed = Permission.VIEW_CHANNEL | Permission.SEND_MESSAGES;

    expect(hasPermission(perms, needed)).toBe(false);
    expect(hasPermission(perms | Permission.SEND_MESSAGES, needed)).toBe(true);
  });
});
