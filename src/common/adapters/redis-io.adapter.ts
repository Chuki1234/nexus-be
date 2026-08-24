import { IoAdapter } from '@nestjs/platform-socket.io';
import { ServerOptions } from 'socket.io';
import { createAdapter } from '@socket.io/redis-adapter';
import Redis from 'ioredis';
import { Logger } from '@nestjs/common';

export class RedisIoAdapter extends IoAdapter {
  private readonly logger = new Logger(RedisIoAdapter.name);
  private adapterConstructor: ReturnType<typeof createAdapter> | null = null;
  private pubClient: Redis | null = null;
  private subClient: Redis | null = null;

  async connectToRedis(redisUrl: string, keyPrefix: string): Promise<void> {
    // Không truyền keyPrefix vào ioredis options để tránh double-prefix khi adapter sử dụng options.key
    this.pubClient = new Redis(redisUrl, {
      maxRetriesPerRequest: null,
      enableReadyCheck: true,
      retryStrategy: (times) => Math.min(times * 100, 3000),
    });

    this.subClient = this.pubClient.duplicate();

    this.pubClient.on('error', (err) => {
      this.logger.error(`Redis pubClient error: ${err.message}`, err.stack);
    });

    this.subClient.on('error', (err) => {
      this.logger.error(`Redis subClient error: ${err.message}`, err.stack);
    });

    await Promise.all([
      new Promise<void>((resolve, reject) => {
        if (this.pubClient!.status === 'ready') return resolve();
        this.pubClient!.once('ready', resolve);
        this.pubClient!.once('error', reject);
      }),
      new Promise<void>((resolve, reject) => {
        if (this.subClient!.status === 'ready') return resolve();
        this.subClient!.once('ready', resolve);
        this.subClient!.once('error', reject);
      }),
    ]);

    const adapterKey = `${keyPrefix}socket.io`;
    this.logger.log(`Khởi tạo Socket.IO Redis Adapter với key prefix: ${adapterKey}`);
    this.adapterConstructor = createAdapter(this.pubClient, this.subClient, {
      key: adapterKey,
    });
  }

  override createIOServer(port: number, options?: ServerOptions): any {
    const server = super.createIOServer(port, options);
    if (this.adapterConstructor) {
      server.adapter(this.adapterConstructor);
    }
    return server;
  }

  async close(): Promise<void> {
    if (this.pubClient) {
      await this.pubClient.quit().catch(() => {});
      this.pubClient = null;
    }
    if (this.subClient) {
      await this.subClient.quit().catch(() => {});
      this.subClient = null;
    }
  }
}
