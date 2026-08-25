import { ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { Pool } from 'pg';
import { AppModule } from '../src/app.module';
import { RedisIoAdapter } from '../src/common/adapters/redis-io.adapter';
import { SupabaseService } from '../src/infra/supabase/supabase.service';

async function bootstrap() {
  const port = parseInt(process.env.PORT || '3301', 10);
  const instanceId = process.env.INSTANCE_ID || `instance-${port}`;
  const redisUrl = process.env.REDIS_URL || 'redis://127.0.0.1:6379';
  const redisKeyPrefix = process.env.REDIS_KEY_PREFIX || 'nexus_test:';
  const dbUrl = process.env.TEST_DATABASE_URL;

  const pgPool = new Pool({ connectionString: dbUrl, max: 10 });

  const user1Id = '11111111-1111-4111-8111-111111111111';
  const user2Id = '22222222-2222-4222-8222-222222222222';
  const user3Id = '33333333-3333-4333-8333-333333333333';

  const tokenResolver = (token: string) => {
    if (token === 'token-user-1') return user1Id;
    if (token === 'token-user-2') return user2Id;
    if (token === 'token-user-3') return user3Id;
    return null;
  };

  const createMockSupabase = () => ({
    client: {
      auth: {
        getUser: async (token: string) => {
          const uid = tokenResolver(token);
          if (uid) return { data: { user: { id: uid, email: `${uid}@test.local` } }, error: null };
          return { data: null, error: { message: 'Invalid token' } };
        },
      },
      from: (table: string) => {
        const createQuery = () => {
          const filters: Array<{ type: 'eq' | 'neq' | 'in' | 'or_part'; col: string; val: any }> = [];
          const buildWhere = () => {
            const orParts = filters.filter((f) => f.type === 'or_part');
            const andParts = filters.filter((f) => f.type !== 'or_part');
            const andClauses: string[] = [];
            const params: any[] = [];
            let paramIdx = 1;
            for (const f of andParts) {
              if (f.type === 'in') {
                andClauses.push(`"${f.col}" = ANY($${paramIdx++})`);
              } else if (f.type === 'neq') {
                andClauses.push(`"${f.col}" != $${paramIdx++}`);
              } else {
                andClauses.push(`"${f.col}" = $${paramIdx++}`);
              }
              params.push(f.val);
            }
            if (orParts.length > 0) {
              const orSub: string[] = [];
              for (const f of orParts) {
                orSub.push(`"${f.col}" = $${paramIdx++}`);
                params.push(f.val);
              }
              andClauses.push('(' + orSub.join(' OR ') + ')');
            }
            let sql = '';
            if (andClauses.length > 0) {
              sql = ' WHERE ' + andClauses.join(' AND ');
            }
            return { sql, params };
          };

          const queryObj: any = {
            eq: (col: string, val: any) => {
              filters.push({ type: 'eq', col, val });
              return queryObj;
            },
            neq: (col: string, val: any) => {
              filters.push({ type: 'neq', col, val });
              return queryObj;
            },
            in: (col: string, vals: any[]) => {
              filters.push({ type: 'in', col, val: vals });
              return queryObj;
            },
            or: (condStr: string) => {
              const parts = condStr.split(',');
              for (const part of parts) {
                const match = part.trim().match(/^([^.]+)\.eq\.(.+)$/);
                if (match) {
                  filters.push({ type: 'or_part', col: match[1], val: match[2] });
                }
              }
              return queryObj;
            },
            order: () => queryObj,
            limit: () => queryObj,
            select: () => queryObj,
            single: async () => {
              const { sql: whereSql, params } = buildWhere();
              const sql = `SELECT * FROM public.${table}${whereSql} LIMIT 1`;
              const res = await pgPool.query(sql, params);
              const row = res.rows[0];
              if (row && table === 'messages') {
                const pRes = await pgPool.query(
                  `SELECT id, username, display_name, avatar_url FROM public.profiles WHERE id = $1`,
                  [row.author_id],
                );
                row.author = pRes.rows[0] || { id: row.author_id, username: 'user', display_name: 'User' };
                row.attachments = [];
                row.reactions = [];
              }
              return { data: row || null, error: null };
            },
            maybeSingle: async () => {
              const { sql: whereSql, params } = buildWhere();
              const sql = `SELECT * FROM public.${table}${whereSql} LIMIT 1`;
              const res = await pgPool.query(sql, params);
              const row = res.rows[0];
              if (row && table === 'messages') {
                const pRes = await pgPool.query(
                  `SELECT id, username, display_name, avatar_url FROM public.profiles WHERE id = $1`,
                  [row.author_id],
                );
                row.author = pRes.rows[0] || { id: row.author_id, username: 'user', display_name: 'User' };
                row.attachments = [];
                row.reactions = [];
              }
              return { data: row || null, error: null };
            },
            then: (resolve: any, reject: any) => {
              const { sql: whereSql, params } = buildWhere();
              const sql = `SELECT * FROM public.${table}${whereSql}`;
              pgPool
                .query(sql, params)
                .then(async (res) => {
                  if (table === 'messages') {
                    for (const row of res.rows) {
                      const pRes = await pgPool.query(
                        `SELECT id, username, display_name, avatar_url FROM public.profiles WHERE id = $1`,
                        [row.author_id],
                      );
                      row.author = pRes.rows[0] || { id: row.author_id, username: 'user', display_name: 'User' };
                      row.attachments = [];
                      row.reactions = [];
                    }
                  }
                  resolve({ data: res.rows, error: null });
                })
                .catch((err) => resolve({ data: null, error: err }));
            },
          };
          return queryObj;
        };
        return {
          select: (...args: any[]) => createQuery(),
          update: (values: any) => {
            const filters: Array<{ col: string; val: any }> = [];
            const updateObj: any = {
              eq: (col: string, val: any) => {
                filters.push({ col, val });
                return updateObj;
              },
              select: (sel?: string) => updateObj,
              then: (resolve: any, reject: any) => {
                const setCols = Object.keys(values);
                let sql = `UPDATE public.${table} SET ` + setCols.map((c, i) => `${c} = $${i + 1}`).join(', ');
                const params: any[] = setCols.map((c) => values[c]);
                if (filters.length > 0) {
                  sql += ' WHERE ' + filters.map((f, i) => `${f.col} = $${setCols.length + i + 1}`).join(' AND ');
                  params.push(...filters.map((f) => f.val));
                }
                sql += ' RETURNING *';
                pgPool
                  .query(sql, params)
                  .then((res) => resolve({ data: res.rows, error: null }))
                  .catch((err) => resolve({ data: null, error: err }));
              },
            };
            return updateObj;
          },
          insert: (values: any) => {
            const rowData = Array.isArray(values) ? values[0] : values;
            const cols = Object.keys(rowData);
            const insertObj: any = {
              select: (sel?: string) => insertObj,
              single: async () => {
                let sql =
                  `INSERT INTO public.${table} (` +
                  cols.map((c) => `"${c}"`).join(', ') +
                  `) VALUES (` +
                  cols.map((_, i) => `$${i + 1}`).join(', ') +
                  `) RETURNING *`;
                const params = cols.map((c) => rowData[c]);
                const res = await pgPool.query(sql, params);
                const row = res.rows[0];
                if (row && table === 'messages') {
                  const pRes = await pgPool.query(
                    `SELECT id, username, display_name, avatar_url FROM public.profiles WHERE id = $1`,
                    [row.author_id],
                  );
                  row.author = pRes.rows[0] || { id: row.author_id, username: 'user', display_name: 'User' };
                  row.attachments = [];
                  row.reactions = [];
                }
                return { data: row || null, error: null };
              },
              maybeSingle: async () => {
                let sql =
                  `INSERT INTO public.${table} (` +
                  cols.map((c) => `"${c}"`).join(', ') +
                  `) VALUES (` +
                  cols.map((_, i) => `$${i + 1}`).join(', ') +
                  `) RETURNING *`;
                const params = cols.map((c) => rowData[c]);
                const res = await pgPool.query(sql, params);
                const row = res.rows[0];
                if (row && table === 'messages') {
                  const pRes = await pgPool.query(
                    `SELECT id, username, display_name, avatar_url FROM public.profiles WHERE id = $1`,
                    [row.author_id],
                  );
                  row.author = pRes.rows[0] || { id: row.author_id, username: 'user', display_name: 'User' };
                  row.attachments = [];
                  row.reactions = [];
                }
                return { data: row || null, error: null };
              },
              then: (resolve: any, reject: any) => {
                let sql =
                  `INSERT INTO public.${table} (` +
                  cols.map((c) => `"${c}"`).join(', ') +
                  `) VALUES (` +
                  cols.map((_, i) => `$${i + 1}`).join(', ') +
                  `) RETURNING *`;
                const params = cols.map((c) => rowData[c]);
                pgPool
                  .query(sql, params)
                  .then((res) => resolve({ data: res.rows, error: null }))
                  .catch((err) => resolve({ data: null, error: err }));
              },
            };
            return insertObj;
          },
          delete: () => createQuery(),
          or: (cond: string) => createQuery(),
        };
      },
      rpc: async (fn: string, params: any) => {
        if (fn === 'claim_storage_cleanup_batch') {
          const res = await pgPool.query(`SELECT * FROM public.claim_storage_cleanup_batch($1, $2)`, [
            params.p_worker_id,
            params.p_limit,
          ]);
          return { data: res.rows, error: null };
        }
        if (fn === 'create_channel_message') {
          try {
            const res = await pgPool.query(
              `SELECT public.create_channel_message($1, $2, $3, $4, $5, $6, $7) AS result`,
              [
                params.p_channel_id,
                params.p_author_id,
                params.p_content,
                params.p_client_nonce,
                params.p_reply_to_id,
                JSON.stringify(params.p_attachments || []),
                params.p_is_forwarded,
              ],
            );
            return { data: res.rows[0]?.result || null, error: null };
          } catch (err: any) {
            return { data: null, error: { message: err.message, code: err.code } };
          }
        }
        if (fn === 'create_conversation_message') {
          try {
            const res = await pgPool.query(
              `SELECT public.create_conversation_message($1, $2, $3, $4, $5, $6, $7) AS result`,
              [
                params.p_conversation_id,
                params.p_author_id,
                params.p_content,
                params.p_client_nonce,
                params.p_reply_to_id,
                JSON.stringify(params.p_attachments || []),
                params.p_is_forwarded,
              ],
            );
            return { data: res.rows[0]?.result || null, error: null };
          } catch (err: any) {
            return { data: null, error: { message: err.message, code: err.code } };
          }
        }
        if (fn === 'start_direct_call') {
          try {
            const res = await pgPool.query(
              `SELECT * FROM public.start_direct_call($1, $2, $3, $4, $5)`,
              [
                params.p_conversation_id,
                params.p_caller_id,
                params.p_caller_session_id,
                params.p_initial_mode,
                params.p_ring_timeout_seconds || 45,
              ],
            );
            return { data: res.rows, error: null };
          } catch (err: any) {
            return { data: null, error: { message: err.message, code: err.code } };
          }
        }
        if (fn === 'answer_direct_call') {
          try {
            const res = await pgPool.query(
              `SELECT * FROM public.answer_direct_call($1, $2, $3)`,
              [params.p_call_id, params.p_user_id, params.p_client_session_id],
            );
            return { data: res.rows, error: null };
          } catch (err: any) {
            return { data: null, error: { message: err.message, code: err.code } };
          }
        }
        if (fn === 'decline_direct_call') {
          try {
            const res = await pgPool.query(
              `SELECT * FROM public.decline_direct_call($1, $2)`,
              [params.p_call_id, params.p_user_id],
            );
            return { data: res.rows, error: null };
          } catch (err: any) {
            return { data: null, error: { message: err.message, code: err.code } };
          }
        }
        if (fn === 'cancel_direct_call') {
          try {
            const res = await pgPool.query(
              `SELECT * FROM public.cancel_direct_call($1, $2)`,
              [params.p_call_id, params.p_user_id],
            );
            return { data: res.rows, error: null };
          } catch (err: any) {
            return { data: null, error: { message: err.message, code: err.code } };
          }
        }
        if (fn === 'end_direct_call') {
          try {
            const res = await pgPool.query(
              `SELECT * FROM public.end_direct_call($1, $2, $3)`,
              [params.p_call_id, params.p_user_id, params.p_end_reason || 'hangup'],
            );
            return { data: res.rows, error: null };
          } catch (err: any) {
            return { data: null, error: { message: err.message, code: err.code } };
          }
        }
        if (fn === 'mark_direct_call_connected') {
          try {
            const res = await pgPool.query(
              `SELECT * FROM public.mark_direct_call_connected($1)`,
              [params.p_call_id],
            );
            return { data: res.rows, error: null };
          } catch (err: any) {
            return { data: null, error: { message: err.message, code: err.code } };
          }
        }
        if (fn === 'expire_ringing_direct_calls') {
          try {
            const res = await pgPool.query(`SELECT * FROM public.expire_ringing_direct_calls()`);
            return { data: res.rows, error: null };
          } catch (err: any) {
            return { data: null, error: { message: err.message, code: err.code } };
          }
        }
        return { data: null, error: null };
      },
      storage: {
        from: (bucket: string) => ({
          remove: async (paths: string[]) => ({ data: paths, error: null }),
        }),
      },
    },
  });

  const moduleRef = await Test.createTestingModule({
    imports: [AppModule],
  })
    .overrideProvider(SupabaseService)
    .useValue(createMockSupabase())
    .compile();

  const app = moduleRef.createNestApplication({ rawBody: true });
  app.setGlobalPrefix('api');
  app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true }));
  app.useGlobalFilters({
    catch(exception: any, host: any) {
      console.error('SERVER EXCEPTION:', exception?.message, exception?.stack);
      const ctx = host.switchToHttp();
      const response = ctx.getResponse();
      const status = typeof exception?.getStatus === 'function' ? exception.getStatus() : 500;
      response.status(status).json({ message: exception?.message || 'Internal Error', status });
    },
  });

  const redisIoAdapter = new RedisIoAdapter(app);
  await redisIoAdapter.connectToRedis(redisUrl, redisKeyPrefix);
  app.useWebSocketAdapter(redisIoAdapter);

  await app.listen(port);

  if (process.send) {
    process.send({
      type: 'READY',
      pid: process.pid,
      port,
      instanceId,
    });
  }

  process.on('message', async (msg: any) => {
    if (msg === 'SHUTDOWN') {
      await app.close();
      await pgPool.end();
      process.exit(0);
    }
  });
}

bootstrap().catch((err) => {
  console.error('Child Node Worker Fatal Error:', err);
  process.exit(1);
});
