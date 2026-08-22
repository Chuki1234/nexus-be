import { createClient } from '@supabase/supabase-js';
import * as dotenv from 'dotenv';
import * as path from 'path';

dotenv.config({ path: path.resolve(__dirname, '../.env') });

const isRequested = process.env.RUN_RPC_SMOKE_TEST === 'true';
const expectedProjectRef = process.env.RPC_SMOKE_EXPECTED_PROJECT_REF;
const conversationId = process.env.DM_E2E_CONVERSATION_ID;
const userId = process.env.DM_E2E_USER_ID;
const supabaseUrl = process.env.SUPABASE_URL || '';
const supabaseAnonKey = process.env.SUPABASE_ANON_KEY || '';
const supabaseServiceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY || '';

export interface SmokeTestReport {
  permissionCheckPassed: boolean;
  nonParticipantCheckPassed: boolean;
  wrongConversationCheckPassed: boolean;
  forwardLowUpdatePassed: boolean;
  forwardHighUpdatePassed: boolean;
  duplicateHighUpdatePassed: boolean;
  staleLowUpdatePassed: boolean;
  readStateMonotonicPreserved: boolean;
  mentionCountPreserved: boolean;
  timestampPreserved: boolean;
  stringTypePreserved: boolean;
  stateRestoredSuccessfully: boolean;
}

export async function runRpcSmokeTest(): Promise<SmokeTestReport> {
  console.log('🧪 Bắt đầu Smoke Test RPC mark_conversation_read...');

  // 1. Kiểm tra cờ kích hoạt và các biến môi trường bắt buộc
  if (!isRequested) {
    throw new Error(
      'BLOCKER: Script chỉ chạy khi RUN_RPC_SMOKE_TEST=true. Vui lòng thiết lập biến môi trường trước khi chạy.',
    );
  }

  if (!expectedProjectRef) {
    throw new Error(
      'BLOCKER: Thiếu biến môi trường bắt buộc RPC_SMOKE_EXPECTED_PROJECT_REF (không có giá trị mặc định).',
    );
  }

  if (!conversationId || !userId) {
    throw new Error(
      'BLOCKER: Thiếu DM_E2E_CONVERSATION_ID hoặc DM_E2E_USER_ID. Vui lòng cung cấp đúng ID cuộc trò chuyện và user test chuyên dụng.',
    );
  }

  if (!supabaseUrl || !supabaseAnonKey || !supabaseServiceRoleKey) {
    throw new Error('BLOCKER: Thiếu cấu hình SUPABASE_URL, SUPABASE_ANON_KEY hoặc SUPABASE_SERVICE_ROLE_KEY.');
  }

  // 2. Xác minh URL khớp chính xác hostname ${expectedProjectRef}.supabase.co
  let parsedUrl: URL;
  try {
    parsedUrl = new URL(supabaseUrl);
  } catch (err: any) {
    throw new Error(`BLOCKER: SUPABASE_URL không hợp lệ: ${err.message}`);
  }

  const expectedHostname = `${expectedProjectRef}.supabase.co`;
  if (parsedUrl.hostname !== expectedHostname) {
    throw new Error(
      `BLOCKER: Hostname của SUPABASE_URL (${parsedUrl.hostname}) không khớp chính xác với expected hostname (${expectedHostname}). Dừng lại ngay lập tức.`,
    );
  }

  const serviceClient = createClient(supabaseUrl, supabaseServiceRoleKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

  const anonClient = createClient(supabaseUrl, supabaseAnonKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

  const report: SmokeTestReport = {
    permissionCheckPassed: false,
    nonParticipantCheckPassed: false,
    wrongConversationCheckPassed: false,
    forwardLowUpdatePassed: false,
    forwardHighUpdatePassed: false,
    duplicateHighUpdatePassed: false,
    staleLowUpdatePassed: false,
    readStateMonotonicPreserved: false,
    mentionCountPreserved: false,
    timestampPreserved: false,
    stringTypePreserved: false,
    stateRestoredSuccessfully: false,
  };

  // 3. Bước 1: service_role gọi RPC trước với fake non-participant
  console.log('1️⃣ Kiểm tra RPC tồn tại và quyền service_role với non-participant (kỳ vọng 42501)...');
  const fakeUserId = '00000000-0000-0000-0000-000000000000';
  const { error: nonPartErr } = await serviceClient.rpc('mark_conversation_read', {
    p_user_id: fakeUserId,
    p_conversation_id: conversationId,
    p_message_id: '1',
  });

  if (!nonPartErr) {
    throw new Error('❌ Thất bại: Gọi RPC với non-participant không báo lỗi.');
  }

  if (nonPartErr.code === 'PGRST202') {
    throw new Error(
      '❌ Thất bại: Function public.mark_conversation_read chưa tồn tại trên database hoặc schema cache của PostgREST chưa reload.',
    );
  }

  if (nonPartErr.code !== '42501' || !nonPartErr.message.includes('not a participant')) {
    throw new Error(
      `❌ Kỳ vọng lỗi code 42501 'User is not a participant', nhận code=[${nonPartErr.code}] msg=${nonPartErr.message}`,
    );
  }
  report.nonParticipantCheckPassed = true;
  console.log('  ✅ Function tồn tại, schema cache đã nhận, service_role có quyền execute và từ chối non-participant đúng 42501.');

  // 4. Bước 2: Chỉ sau khi service_role chứng minh function tồn tại, mới kiểm tra anon
  console.log('2️⃣ Kiểm tra phân quyền anon không thể tiếp cận RPC...');
  const { error: anonErr } = await anonClient.rpc('mark_conversation_read', {
    p_user_id: userId,
    p_conversation_id: conversationId,
    p_message_id: '1',
  });

  if (!anonErr) {
    throw new Error('❌ Thất bại: anon client có thể gọi RPC mark_conversation_read thành công (lỗ hổng bảo mật).');
  }

  const fullAnonErrMsg = `${anonErr.message || ''} ${anonErr.details || ''} ${anonErr.hint || ''}`.toLowerCase();

  // Tuyệt đối không chấp nhận lỗi "not a participant" làm chứng cứ pass phân quyền anon
  if (fullAnonErrMsg.includes('not a participant')) {
    throw new Error('❌ Thất bại: anon vượt qua được tầng phân quyền PostgreSQL và chạm vào business logic trong hàm.');
  }

  // Chấp nhận permission denied hoặc PGRST202 (PostgREST ẩn hàm khỏi schema cache với role thiếu quyền EXECUTE)
  const isAnonBlocked =
    anonErr.code === 'PGRST202' ||
    fullAnonErrMsg.includes('permission denied for function') ||
    fullAnonErrMsg.includes('permission denied for schema');

  if (!isAnonBlocked) {
    throw new Error(
      `❌ Kỳ vọng lỗi permission denied hoặc PGRST202 cho anon, nhận: [${anonErr.code}] ${anonErr.message}`,
    );
  }
  report.permissionCheckPassed = true;
  console.log('  ✅ Anon bị chặn tiếp cận RPC thành công (PostgreSQL permission denied hoặc PGRST202 role isolation).');

  // 5. Kiểm tra wrong conversation / non-existent message (22023)
  console.log('3️⃣ Kiểm tra wrong conversation / message không tồn tại (kỳ vọng 22023)...');
  const { error: wrongMsgErr } = await serviceClient.rpc('mark_conversation_read', {
    p_user_id: userId,
    p_conversation_id: conversationId,
    p_message_id: '99999999999999999',
  });

  if (!wrongMsgErr || wrongMsgErr.code !== '22023' || !wrongMsgErr.message.includes('does not exist')) {
    throw new Error(
      `❌ Kỳ vọng lỗi code 22023 'Message does not exist in this conversation', nhận code=[${wrongMsgErr?.code}] msg=${wrongMsgErr?.message}`,
    );
  }
  report.wrongConversationCheckPassed = true;
  console.log('  ✅ Message không tồn tại bị từ chối chính xác với code 22023.');

  // 6. Snapshot read_state ban đầu của đúng (userId, conversationId)
  console.log('4️⃣ Snapshot read_state ban đầu và chuẩn bị test messages...');
  const { data: initialReadState, error: snapErr } = await serviceClient
    .from('read_states')
    .select('last_read_message_id, mention_count, updated_at')
    .eq('user_id', userId)
    .eq('conversation_id', conversationId)
    .maybeSingle();

  if (snapErr) {
    throw new Error(`❌ Snapshot read_states thất bại: ${snapErr.message}`);
  }

  // BigInt safety check trên snapshot
  if (initialReadState?.last_read_message_id !== undefined && initialReadState?.last_read_message_id !== null) {
    if (
      typeof initialReadState.last_read_message_id === 'number' &&
      !Number.isSafeInteger(initialReadState.last_read_message_id)
    ) {
      throw new Error('❌ Dừng lại: Snapshot chứa last_read_message_id dạng number không an toàn (unsafe integer).');
    }
  }

  const initialRowExists = Boolean(initialReadState);
  console.log(`  📸 Đã snapshot read_state ban đầu: rowExists=${initialRowExists}`);

  const runId = `rpc-smoke-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
  let msgLowId: string | null = null;
  let msgHighId: string | null = null;

  try {
    // Tạo 2 message test liên tiếp để đảm bảo msgLow < msgHigh
    const { data: msgLow, error: msgLowErr } = await serviceClient
      .from('messages')
      .insert({
        conversation_id: conversationId,
        author_id: userId,
        content: `[${runId}] Message Low`,
      })
      .select('id')
      .single();

    if (msgLowErr || !msgLow) {
      throw new Error(`❌ Tạo message test msgLow thất bại: ${msgLowErr?.message}`);
    }
    msgLowId = msgLow.id.toString();

    const { data: msgHigh, error: msgHighErr } = await serviceClient
      .from('messages')
      .insert({
        conversation_id: conversationId,
        author_id: userId,
        content: `[${runId}] Message High`,
      })
      .select('id')
      .single();

    if (msgHighErr || !msgHigh) {
      throw new Error(`❌ Tạo message test msgHigh thất bại: ${msgHighErr?.message}`);
    }
    msgHighId = msgHigh.id.toString();

    // 7. Test Monotonic:
    // 7a. Mark msgLow -> updated = true
    console.log('5️⃣ Kiểm tra mark msgLow (Forward Update)...');
    const { data: resLow, error: errLow } = await serviceClient.rpc('mark_conversation_read', {
      p_user_id: userId,
      p_conversation_id: conversationId,
      p_message_id: msgLowId,
    });

    if (errLow || !resLow || resLow.length === 0 || !resLow[0].success || resLow[0].updated !== true) {
      throw new Error(`❌ Mark msgLow thất bại: ${errLow?.message || JSON.stringify(resLow)}`);
    }
    report.forwardLowUpdatePassed = true;
    report.stringTypePreserved = typeof resLow[0].last_read_message_id === 'string';

    // 7b. Mark msgHigh -> updated = true
    console.log('6️⃣ Kiểm tra mark msgHigh (Forward Update)...');
    const { data: resHigh, error: errHigh } = await serviceClient.rpc('mark_conversation_read', {
      p_user_id: userId,
      p_conversation_id: conversationId,
      p_message_id: msgHighId,
    });

    if (errHigh || !resHigh || resHigh.length === 0 || !resHigh[0].success || resHigh[0].updated !== true) {
      throw new Error(`❌ Mark msgHigh thất bại: ${errHigh?.message || JSON.stringify(resHigh)}`);
    }
    if (resHigh[0].last_read_message_id !== msgHighId) {
      throw new Error(`❌ last_read_message_id không khớp msgHighId: ${resHigh[0].last_read_message_id} != ${msgHighId}`);
    }
    report.forwardHighUpdatePassed = true;

    // Lấy state sau khi mark msgHigh
    const { data: stateAfterHigh, error: stateAfterHighErr } = await serviceClient
      .from('read_states')
      .select('last_read_message_id, mention_count, updated_at')
      .eq('user_id', userId)
      .eq('conversation_id', conversationId)
      .single();

    if (stateAfterHighErr || !stateAfterHigh) {
      throw new Error(`❌ Lấy read_state sau khi mark msgHigh thất bại: ${stateAfterHighErr?.message}`);
    }

    const timestampAfterHigh = stateAfterHigh.updated_at;
    const mentionCountAfterHigh = stateAfterHigh.mention_count;

    // 7c. Duplicate call với msgHigh -> updated = false
    console.log('7️⃣ Kiểm tra Duplicate call với msgHigh (kỳ vọng updated=false)...');
    const { data: resDup, error: errDup } = await serviceClient.rpc('mark_conversation_read', {
      p_user_id: userId,
      p_conversation_id: conversationId,
      p_message_id: msgHighId,
    });

    if (errDup || !resDup || resDup.length === 0 || resDup[0].updated !== false) {
      throw new Error(`❌ Duplicate call phải trả updated=false: ${errDup?.message || JSON.stringify(resDup)}`);
    }
    if (resDup[0].last_read_message_id !== msgHighId) {
      throw new Error(`❌ Duplicate call làm thay đổi last_read_message_id: ${resDup[0].last_read_message_id}`);
    }
    report.duplicateHighUpdatePassed = true;

    // 7d. Stale call với msgLow -> updated = false
    console.log('8️⃣ Kiểm tra Stale call với msgLow (kỳ vọng updated=false)...');
    const { data: resStale, error: errStale } = await serviceClient.rpc('mark_conversation_read', {
      p_user_id: userId,
      p_conversation_id: conversationId,
      p_message_id: msgLowId,
    });

    if (errStale || !resStale || resStale.length === 0 || resStale[0].updated !== false) {
      throw new Error(`❌ Stale call phải trả updated=false: ${errStale?.message || JSON.stringify(resStale)}`);
    }
    if (resStale[0].last_read_message_id !== msgHighId) {
      throw new Error(`❌ Stale call làm lùi last_read_message_id: ${resStale[0].last_read_message_id}`);
    }
    report.staleLowUpdatePassed = true;

    // 7e. Kiểm tra DB: last_read vẫn là msgHigh, updated_at và mention_count không bị thay đổi bởi stale/duplicate
    const { data: stateFinal, error: stateFinalErr } = await serviceClient
      .from('read_states')
      .select('last_read_message_id, mention_count, updated_at')
      .eq('user_id', userId)
      .eq('conversation_id', conversationId)
      .single();

    if (stateFinalErr || !stateFinal) {
      throw new Error(`❌ Lấy stateFinal thất bại: ${stateFinalErr?.message}`);
    }

    if (stateFinal.last_read_message_id?.toString() !== msgHighId) {
      throw new Error(`❌ last_read_message_id bị thay đổi bất thường: ${stateFinal.last_read_message_id} != ${msgHighId}`);
    }
    report.readStateMonotonicPreserved = true;

    if (stateFinal.mention_count !== mentionCountAfterHigh) {
      throw new Error(`❌ mention_count bị thay đổi bởi stale/duplicate: ${stateFinal.mention_count} != ${mentionCountAfterHigh}`);
    }
    report.mentionCountPreserved = true;

    if (stateFinal.updated_at !== timestampAfterHigh) {
      throw new Error(`❌ updated_at bị thay đổi bởi stale/duplicate: ${stateFinal.updated_at} != ${timestampAfterHigh}`);
    }
    report.timestampPreserved = true;

    console.log('  ✅ Monotonic, mention_count và updated_at đều được bảo toàn hoàn hảo.');
  } finally {
    // 8. Khôi phục chính xác trạng thái ban đầu và verify trong finally block
    console.log('🧹 Khôi phục trạng thái read_state và dọn dẹp test messages...');
    let cleanupFailed = false;
    let cleanupErrorDetail = '';

    // 8a. Khôi phục hoặc xóa read_state
    if (initialRowExists && initialReadState) {
      const { error: restoreErr } = await serviceClient
        .from('read_states')
        .update({
          last_read_message_id: initialReadState.last_read_message_id,
          mention_count: initialReadState.mention_count,
          updated_at: initialReadState.updated_at,
        })
        .eq('user_id', userId)
        .eq('conversation_id', conversationId);

      if (restoreErr) {
        cleanupFailed = true;
        cleanupErrorDetail += ` [Restore read_state: ${restoreErr.message}]`;
      }
    } else {
      const { error: delStateErr } = await serviceClient
        .from('read_states')
        .delete()
        .eq('user_id', userId)
        .eq('conversation_id', conversationId);

      if (delStateErr) {
        cleanupFailed = true;
        cleanupErrorDetail += ` [Delete read_state: ${delStateErr.message}]`;
      }
    }

    // 8b. Xóa 2 message test sau khi đã khôi phục read_state
    if (msgLowId) {
      const { error: delLowErr } = await serviceClient.from('messages').delete().eq('id', msgLowId);
      if (delLowErr) {
        cleanupFailed = true;
        cleanupErrorDetail += ` [Delete msgLow: ${delLowErr.message}]`;
      }
    }
    if (msgHighId) {
      const { error: delHighErr } = await serviceClient.from('messages').delete().eq('id', msgHighId);
      if (delHighErr) {
        cleanupFailed = true;
        cleanupErrorDetail += ` [Delete msgHigh: ${delHighErr.message}]`;
      }
    }

    // 8c. Query lại để xác minh dọn dẹp triệt để (bắt lỗi từng query, không chấp nhận data=null khi query có error)
    const { data: verifiedState, error: verifyStateErr } = await serviceClient
      .from('read_states')
      .select('last_read_message_id, mention_count, updated_at')
      .eq('user_id', userId)
      .eq('conversation_id', conversationId)
      .maybeSingle();

    if (verifyStateErr) {
      cleanupFailed = true;
      cleanupErrorDetail += ` [Verify read_state query error: ${verifyStateErr.message}]`;
    } else {
      if (initialRowExists && initialReadState) {
        if (
          !verifiedState ||
          verifiedState.last_read_message_id?.toString() !== initialReadState.last_read_message_id?.toString() ||
          verifiedState.mention_count !== initialReadState.mention_count ||
          verifiedState.updated_at !== initialReadState.updated_at
        ) {
          cleanupFailed = true;
          cleanupErrorDetail += ' [Verification: read_state không khớp snapshot ban đầu]';
        }
      } else {
        if (verifiedState !== null) {
          cleanupFailed = true;
          cleanupErrorDetail += ' [Verification: read_state test row chưa được xóa]';
        }
      }
    }

    if (msgLowId) {
      const { data: checkLow, error: checkLowErr } = await serviceClient
        .from('messages')
        .select('id')
        .eq('id', msgLowId)
        .maybeSingle();

      if (checkLowErr) {
        cleanupFailed = true;
        cleanupErrorDetail += ` [Verify msgLow query error: ${checkLowErr.message}]`;
      } else if (checkLow !== null) {
        cleanupFailed = true;
        cleanupErrorDetail += ' [Verification: msgLow chưa được xóa]';
      }
    }

    if (msgHighId) {
      const { data: checkHigh, error: checkHighErr } = await serviceClient
        .from('messages')
        .select('id')
        .eq('id', msgHighId)
        .maybeSingle();

      if (checkHighErr) {
        cleanupFailed = true;
        cleanupErrorDetail += ` [Verify msgHigh query error: ${checkHighErr.message}]`;
      } else if (checkHigh !== null) {
        cleanupFailed = true;
        cleanupErrorDetail += ' [Verification: msgHigh chưa được xóa]';
      }
    }

    if (cleanupFailed) {
      report.stateRestoredSuccessfully = false;
      throw new Error(`❌ Cleanup trong finally thất bại:${cleanupErrorDetail}`);
    } else {
      report.stateRestoredSuccessfully = true;
      console.log('  ✅ Khôi phục snapshot ban đầu, xóa test messages và xác minh thành công 100%.');
    }
  }

  // 9. Khẳng định tất cả các bước đều đạt 100%
  const allPassed = Object.values(report).every((v) => v === true);
  if (!allPassed) {
    throw new Error(`❌ Một số bước kiểm thử không đạt: ${JSON.stringify(report, null, 2)}`);
  }

  console.log('🎉 [PASS] Toàn bộ RPC Smoke Test cho mark_conversation_read đã thành công 100%!');
  return report;
}

if (require.main === module) {
  runRpcSmokeTest()
    .then(() => process.exit(0))
    .catch((err) => {
      console.error('❌ Lỗi Smoke Test:', err.message);
      process.exit(1);
    });
}
