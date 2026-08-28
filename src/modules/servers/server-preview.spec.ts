import {
  BadRequestException,
  InternalServerErrorException,
  NotFoundException,
} from '@nestjs/common';
import { ServersService } from './servers.service';
import { ServerPreviewController } from './servers.controller';

/**
 * Test cho endpoint public GET /api/servers/:serverId/preview (feature Profile
 * Embed — Phase 2). Cố tình dựng service/controller bằng `new` trực tiếp thay vì
 * Nest TestingModule: chỉ cần test một method thuần, khởi tạo tay tránh phải nạp
 * cả cây DI của ServersModule.
 */
describe('Server preview (getServerPreview)', () => {
  const SERVER_ID = '11111111-2222-4333-8444-555555555555';

  function buildService(fromImpl: (table: string) => any): ServersService {
    const supabase = { client: { from: jest.fn(fromImpl) } } as any;
    // Ba dependency còn lại không được getServerPreview dùng tới → mock rỗng.
    return new ServersService(supabase, {} as any, {} as any, {} as any);
  }

  function serverThenMembers(row: any, memberCount: number | null) {
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
          eq: jest.fn().mockResolvedValue({ count: memberCount }),
        };
      }
      return {};
    };
  }

  describe('ServersService.getServerPreview', () => {
    it('trả ServerPreviewDto chỉ gồm field công khai an toàn (không lộ owner_id)', async () => {
      const service = buildService(
        serverThenMembers(
          {
            id: SERVER_ID,
            name: 'Nexus HQ',
            icon_url: 'https://cdn/icon.png',
            banner_url: 'https://cdn/banner.png',
            owner_id: 'secret-owner-id',
          },
          7,
        ),
      );

      const res = await service.getServerPreview(SERVER_ID);

      expect(res).toEqual({
        serverId: SERVER_ID,
        name: 'Nexus HQ',
        iconUrl: 'https://cdn/icon.png',
        bannerUrl: 'https://cdn/banner.png',
        memberCount: 7,
      });
      // Đúng bộ key công khai — không rò rỉ owner_id hay field nhạy cảm.
      expect(Object.keys(res).sort()).toEqual([
        'bannerUrl',
        'iconUrl',
        'memberCount',
        'name',
        'serverId',
      ]);
    });

    it('mặc định memberCount = 1 khi count trả null', async () => {
      const service = buildService(
        serverThenMembers(
          { id: SERVER_ID, name: 'S', icon_url: null, banner_url: null },
          null,
        ),
      );
      const res = await service.getServerPreview(SERVER_ID);
      expect(res.memberCount).toBe(1);
    });

    it('ném BadRequestException khi serverId không phải uuid (không đụng DB)', async () => {
      const fromSpy = jest.fn();
      const service = buildService(fromSpy);

      await expect(service.getServerPreview('not-a-uuid')).rejects.toBeInstanceOf(
        BadRequestException,
      );
      await expect(service.getServerPreview('   ')).rejects.toBeInstanceOf(
        BadRequestException,
      );
      // id rác bị chặn trước khi bắn query xuống Postgres.
      expect(fromSpy).not.toHaveBeenCalled();
    });

    it('ném NotFoundException khi máy chủ không tồn tại', async () => {
      const service = buildService(serverThenMembers(null, 0));
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
