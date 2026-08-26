import { IsEnum, IsOptional } from 'class-validator';

export enum DeleteMessageScope {
  FOR_ME = 'for_me',
  EVERYONE = 'everyone',
}

export class DeleteMessageQueryDto {
  @IsOptional()
  @IsEnum(DeleteMessageScope, {
    message: 'scope phải là "for_me" hoặc "everyone"',
  })
  scope?: DeleteMessageScope;
}
