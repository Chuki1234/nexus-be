import { Module } from '@nestjs/common';
import { MediaService } from './media.service';

/** Không Global: chỉ module nào thật sự nhận file mới import. */
@Module({
  providers: [MediaService],
  exports: [MediaService],
})
export class StorageModule {}
