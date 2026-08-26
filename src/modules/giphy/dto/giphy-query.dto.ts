import { Type, Transform } from 'class-transformer';
import { IsInt, IsNotEmpty, IsOptional, IsString, Max, MaxLength, Min } from 'class-validator';

export class GiphyTrendingQueryDto {
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(50)
  limit?: number = 24;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  @Max(4999)
  offset?: number = 0;
}

export class GiphySearchQueryDto extends GiphyTrendingQueryDto {
  @IsString()
  @IsNotEmpty({ message: 'Từ khóa tìm kiếm không được để trống.' })
  @MaxLength(100, { message: 'Từ khóa tìm kiếm tối đa 100 ký tự.' })
  @Transform(({ value }: { value: unknown }) => (typeof value === 'string' ? value.trim() : value))
  q!: string;
}
