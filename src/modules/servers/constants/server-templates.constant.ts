export type ServerTemplateId =
  | 'custom'
  | 'gaming'
  | 'friends'
  | 'study'
  | 'school_club';

export interface ChannelTemplateSeed {
  name: string;
  type: 'text' | 'voice';
  position: number;
}

export interface ServerTemplateDefinition {
  id: ServerTemplateId;
  name: string;
  description: string;
  icon: string;
  textChannelCount: number;
  voiceChannelCount: number;
  channels: ChannelTemplateSeed[];
}

export const SERVER_TEMPLATES: readonly ServerTemplateDefinition[] = [
  {
    id: 'custom',
    name: 'Tạo mẫu riêng',
    description: 'Tạo không gian trống với kênh chung mặc định',
    icon: 'tune',
    textChannelCount: 1,
    voiceChannelCount: 0,
    channels: [{ name: 'chung', type: 'text', position: 0 }],
  },
  {
    id: 'gaming',
    name: 'Gaming',
    description: 'Dành cho nhóm game, tìm đồng đội và voice chat',
    icon: 'sports_esports',
    textChannelCount: 3,
    voiceChannelCount: 2,
    channels: [
      { name: 'chào-mừng', type: 'text', position: 0 },
      { name: 'tìm-đồng-đội', type: 'text', position: 1 },
      { name: 'ảnh-và-clip', type: 'text', position: 2 },
      { name: 'Phòng chờ', type: 'voice', position: 3 },
      { name: 'Đội 1', type: 'voice', position: 4 },
    ],
  },
  {
    id: 'friends',
    name: 'Bạn bè',
    description: 'Không gian nhỏ ấm cúng cho nhóm bạn thân',
    icon: 'favorite',
    textChannelCount: 3,
    voiceChannelCount: 1,
    channels: [
      { name: 'chung', type: 'text', position: 0 },
      { name: 'kèo-cuối-tuần', type: 'text', position: 1 },
      { name: 'ảnh-và-meme', type: 'text', position: 2 },
      { name: 'Phòng khách', type: 'voice', position: 3 },
    ],
  },
  {
    id: 'study',
    name: 'Nhóm học tập',
    description: 'Thảo luận bài tập, chia sẻ tài liệu và học nhóm',
    icon: 'school',
    textChannelCount: 4,
    voiceChannelCount: 1,
    channels: [
      { name: 'thông-báo', type: 'text', position: 0 },
      { name: 'thảo-luận', type: 'text', position: 1 },
      { name: 'tài-liệu', type: 'text', position: 2 },
      { name: 'bài-tập', type: 'text', position: 3 },
      { name: 'Phòng học', type: 'voice', position: 4 },
    ],
  },
  {
    id: 'school_club',
    name: 'Câu lạc bộ trường học',
    description: 'Tổ chức sự kiện, sinh hoạt câu lạc bộ và ban tổ chức',
    icon: 'groups',
    textChannelCount: 4,
    voiceChannelCount: 1,
    channels: [
      { name: 'thông-báo', type: 'text', position: 0 },
      { name: 'giới-thiệu', type: 'text', position: 1 },
      { name: 'sự-kiện', type: 'text', position: 2 },
      { name: 'ban-tổ-chức', type: 'text', position: 3 },
      { name: 'Sinh hoạt chung', type: 'voice', position: 4 },
    ],
  },
] as const;
