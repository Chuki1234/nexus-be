import {
  registerDecorator,
  ValidationArguments,
  ValidationOptions,
} from 'class-validator';

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
const EARLIEST = Date.UTC(1900, 0, 1);

/**
 * Đọc chuỗi `YYYY-MM-DD` một cách nghiêm ngặt.
 *
 * `new Date('2001-02-30')` không ném lỗi mà tự cuộn sang 02/03, nên phải đối
 * chiếu lại từng thành phần thì mới loại được ngày không tồn tại.
 */
function parseIsoDate(value: unknown): Date | null {
  if (typeof value !== 'string' || !ISO_DATE.test(value)) {
    return null;
  }
  const [year, month, day] = value.split('-').map(Number);
  const date = new Date(Date.UTC(year, month - 1, day));

  const rolledOver =
    date.getUTCFullYear() !== year ||
    date.getUTCMonth() !== month - 1 ||
    date.getUTCDate() !== day;

  return rolledOver ? null : date;
}

/** Chuỗi `YYYY-MM-DD` có thật, và chủ nhân đã đủ `minAgeYears` tuổi. */
export function IsBirthdate(minAgeYears: number, options?: ValidationOptions) {
  return function (target: object, propertyName: string): void {
    registerDecorator({
      name: 'isBirthdate',
      target: target.constructor,
      propertyName,
      constraints: [minAgeYears],
      options,
      validator: {
        validate(value: unknown): boolean {
          const date = parseIsoDate(value);
          if (!date) {
            return false;
          }
          const now = new Date();
          const cutoff = Date.UTC(
            now.getUTCFullYear() - minAgeYears,
            now.getUTCMonth(),
            now.getUTCDate(),
          );
          return date.getTime() <= cutoff && date.getTime() >= EARLIEST;
        },
        defaultMessage(args: ValidationArguments): string {
          return `Ngày sinh không hợp lệ hoặc chưa đủ ${args.constraints[0]} tuổi.`;
        },
      },
    });
  };
}
