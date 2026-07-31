/**
 * Điểm export duy nhất của `shared/`.
 *
 * Thư mục này được nhân bản y hệt giữa nexus-fe và nexus-be (hai repo git tách
 * rời nên không import chéo được). Sửa một bên phải sửa cả hai — chạy
 * `npm run check:shared` để phát hiện lệch.
 *
 * Chỉ đặt ở đây những gì CẢ HAI phía cùng cần: hợp đồng dữ liệu, hằng số, và
 * logic thuần không phụ thuộc framework. Không import gì từ Angular, NestJS,
 * Supabase hay Node.
 */

export * from './permissions';
export * from './socket-events';
export * from './dto/auth';
export * from './dto/common';
