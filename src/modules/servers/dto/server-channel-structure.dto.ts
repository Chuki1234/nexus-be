import { IsObject } from 'class-validator';

export interface ServerChannelStructureCategoryDto {
  id: string;
  name: string;
  isPrivate?: boolean;
}

export type ServerChannelStructureRootItemDto =
  { kind: 'category'; id: string } | { kind: 'channel'; id: string };

export interface ServerChannelStructureDto {
  version: 1;
  categories: ServerChannelStructureCategoryDto[];
  rootItems: ServerChannelStructureRootItemDto[];
  categoryChannels: Record<string, string[]>;
  revision?: number;
  updatedAt?: string | null;
}

export class UpdateServerChannelStructureDto {
  @IsObject({ message: 'Cấu trúc kênh phải là một object hợp lệ.' })
  structure!: ServerChannelStructureDto;
}
