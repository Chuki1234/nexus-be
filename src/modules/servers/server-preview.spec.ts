import {
  BadRequestException,
  InternalServerErrorException,
  NotFoundException,
} from '@nestjs/common';
import { ServersService } from './servers.service';
import { ServerPreviewController } from './servers.controller';

/**
 * Test cho endpoint public GET /api/servers/:serverId/preview (feature Profile
 * Embed — Phase 2 + làm giàu Phase 6). Dựng service/controller bằng `new` trực
 * tiếp để chỉ test một method thuần, tránh nạp cả cây DI của ServersModule.
 */
describe('Server preview (getServerPreview)', () => {
  const SERVER_ID = '11111111-2222-4333-8444-555555555555';
  const CREATED_AT = '2026-01-15T00:00:00.000Z';

  function buildService(
    fromImpl: (table: string) => any,
    onlineIds: string[] = [],
  ): ServersService {
    const supabase = { client: { from: jest.fn(fromImpl) } } as any;
    const presence = {
      getEffectiveStatus: jest.fn((id: string) =>
        onlineIds.includes(id) ? 'online' : 'offline',
      ),
    } as any;
    // Các dependency khác không được getServerPreview dùng → mock rỗng.
    return new ServersService(
      supabase,
      {} as any,
      {} as any,
      {} as any,
      presence,
    );
  }

  function serverThenMembers(row: any, memberIds: string[]) {
    return (table: string) => {
      if (table === 'servers') {
        return {
          select: jest.fn().mockReturnThis(),
          eq: jest.fn().mockReturnThis(),
          maybeSingle: jest.fn().mockResolvedValue({ data: row, error: null }),
        };
      }
      if (table === 'server_members') {
        return {
          select: jest.fn().mockReturnThis(),
          eq: jest
            .fn()
            .mockResolvedValue({ data: memberIds.map((id) => ({ user_id: id })) }),
        };
      }
      return {};
    };
  }

  const fullRow = {
    id: SERVER_ID,
    name: 'Nexus HQ',
    icon_url: 'https://cdn/icon.png',
    banner_url: null,
    description: 'Server đồ án',
    tags: ['Gaming', 'Học tập'],
    created_at: CREATED_AT,
    owner_id: 'secret-owner-id',
  };

  describe('ServersService.getServerPreview', () => {
    it('trả ServerPreviewDto đủ field mới; onlineCount tính từ presence; không lộ owner_id', async () => {
      const service = buildService(
        serverThenMembers(fullRow, ['u1', 'u2', 'u3']),
        ['u1', 'u2'], // u1,u2 online; u3 offline
      );

      const res = await service.getServerPreview(SERVER_ID);

      expect(res).toEqual({
        serverId: SERVER_ID,
        name: 'Nexus HQ',
        iconUrl: 'https://cdn/icon.png',
        bannerUrl: null,
        memberCount: 3,
        description: 'Server đồ án',
        tags: ['Gaming', 'Học tập'],
        createdAt: CREATED_AT,
        onlineCount: 2,
      });
      expect(Object.keys(res)).not.toContain('owner_id');
    });

    it('memberCount = 1 và onlineCount = 0 khi không có thành viên; tags null → []', async () => {
      const service = buildService(
        serverThenMembers(
          { ...fullRow, description: null, tags: null },
          [],
        ),
      );
      const res = await service.getServerPreview(SERVER_ID);
      expect(res.memberCount).toBe(1);
      expect(res.onlineCount).toBe(0);
      expect(res.description).toBeNull();
      expect(res.tags).toEqual([]);
    });

    it('ném BadRequestException khi serverId không phải uuid (không đụng DB)', async () => {
      const fromSpy = jest.fn();
      const service = buildService(fromSpy);
      await expect(service.getServerPreview('not-a-uuid')).rejects.toBeInstanceOf(
        BadRequestException,
      );
      expect(fromSpy).not.toHaveBeenCalled();
    });

    it('ném NotFoundException khi máy chủ không tồn tại', async () => {
      const service = buildService(serverThenMembers(null, []));
      await expect(service.getServerPreview(SERVER_ID)).rejects.toBeInstanceOf(
        NotFoundException,
      );
    });

    it('ném InternalServerErrorException khi query servers lỗi', async () => {
      const service = buildService((table: string) => {
        if (table === 'servers') {
          return {
            select: jest.fn().mockReturnThis(),
            eq: jest.fn().mockReturnThis(),
            maybeSingle: jest
              .fn()
              .mockResolvedValue({ data: null, error: { message: 'boom' } }),
          };
        }
        return {};
      });
      await expect(service.getServerPreview(SERVER_ID)).rejects.toBeInstanceOf(
        InternalServerErrorException,
      );
    });
  });

  describe('ServerPreviewController', () => {
    it('ủy quyền cho serversService.getServerPreview với đúng serverId', async () => {
      const preview = {
        serverId: SERVER_ID,
        name: 'Nexus HQ',
        iconUrl: null,
        bannerUrl: null,
        memberCount: 3,
        description: null,
        tags: [],
        createdAt: CREATED_AT,
        onlineCount: 1,
      };
      const serviceMock = {
        getServerPreview: jest.fn().mockResolvedValue(preview),
      } as unknown as ServersService;
      const controller = new ServerPreviewController(serviceMock);

      const res = await controller.getServerPreview(SERVER_ID);
      expect(serviceMock.getServerPreview).toHaveBeenCalledWith(SERVER_ID);
      expect(res).toBe(preview);
    });
  });
});
