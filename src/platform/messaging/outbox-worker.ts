import { Logger, OnApplicationBootstrap, OnModuleDestroy } from '@nestjs/common';
import { OutboxDispatcher } from './outbox-dispatcher';

export class OutboxWorker implements OnApplicationBootstrap, OnModuleDestroy {
  private timer?: NodeJS.Timeout;
  private running?: Promise<void>;
  private stopped = false;
  private readonly logger = new Logger(OutboxWorker.name);
  constructor(
    private readonly dispatcher: OutboxDispatcher,
    private readonly pollMs: number,
  ) {}

  onApplicationBootstrap(): void {
    this.schedule(0);
  }
  private schedule(delay: number): void {
    if (this.stopped) return;
    this.timer = setTimeout(() => {
      this.running = this.run().finally(() => {
        this.running = undefined;
        this.schedule(this.pollMs);
      });
    }, delay);
  }
  private async run(): Promise<void> {
    try {
      await this.dispatcher.tick();
    } catch (error) {
      this.logger.error({
        event: 'outbox_tick_failed',
        error: error instanceof Error ? error.message : 'unknown',
      });
    }
  }
  async onModuleDestroy(): Promise<void> {
    this.stopped = true;
    clearTimeout(this.timer);
    await this.running;
  }
}
