import { IsString, MaxLength } from 'class-validator';
import { PROFILE_NOTE_MAX } from '../../../shared';

/** Thân request của PUT /api/profiles/:username/note. Chuỗi rỗng = xoá ghi chú. */
export class SetProfileNoteDto {
  @IsString({ message: 'Ghi chú không hợp lệ.' })
  @MaxLength(PROFILE_NOTE_MAX, { message: `Ghi chú tối đa ${PROFILE_NOTE_MAX} ký tự.` })
  text!: string;
}
