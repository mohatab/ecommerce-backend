import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { AppConfig } from '../../config/configuration';
import { PrismaService } from '../../prisma/prisma.service';
import { JobCounts } from './job-counts';

const DAY_MS = 86_400_000;

/**
 * Retention for the two tables that otherwise grow without limit.
 *
 * Each table is purged independently: one failing is logged, counted in
 * `failed`, and does not stop the other. Both deletes are bounded by
 * `purgeBatchSize`, oldest first (Prisma's deleteMany has no take/orderBy, so
 * the batch is selected by id and deleted by id AND the cutoff predicate), and
 * idempotent by predicate — a second run finds nothing more.
 */
@Injectable()
export class MaintenancePurgeService {
  private readonly logger = new Logger(MaintenancePurgeService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService<AppConfig, true>,
  ) {}

  async run(): Promise<JobCounts> {
    const counts: JobCounts = {
      examined: 0,
      affected: 0,
      skipped: 0,
      failed: 0,
    };

    for (const [table, purge] of [
      ['refresh_tokens', () => this.purgeRefreshTokens()],
      ['payment_events', () => this.purgePaymentEvents()],
    ] as const) {
      try {
        const { examined, affected } = await purge();
        counts.examined += examined;
        counts.affected += affected;
      } catch (error) {
        counts.failed += 1;
        this.logger.error(
          `Purge of ${table} failed: ${
            error instanceof Error ? error.message : 'unknown error'
          }`,
        );
      }
    }

    return counts;
  }

  private cutoff(days: number): Date {
    return new Date(Date.now() - days * DAY_MS);
  }

  /**
   * The cutoff is on expiresAt, NOT createdAt: a long-lived valid token must
   * never be deleted. Revoked-but-unexpired rows are retained until their own
   * expiry passes the cutoff, because they are reuse-detection evidence —
   * Phase 1 revokes a whole family on replay, and deleting the row early turns
   * a detectable replay into an unknown token.
   */
  private async purgeRefreshTokens(): Promise<{
    examined: number;
    affected: number;
  }> {
    const expiresAt = {
      lt: this.cutoff(
        this.config.get('maintenance.refreshTokenRetentionDays', {
          infer: true,
        }),
      ),
    };
    const rows = await this.prisma.refreshToken.findMany({
      where: { expiresAt },
      orderBy: { expiresAt: 'asc' },
      take: this.config.get('maintenance.purgeBatchSize', { infer: true }),
      select: { id: true },
    });
    const { count } = await this.prisma.refreshToken.deleteMany({
      where: { id: { in: rows.map((r) => r.id) }, expiresAt },
    });

    return { examined: rows.length, affected: count };
  }

  /**
   * The cutoff is on createdAt. This table is the webhook idempotency ledger,
   * so deleting a row makes a replayed delivery from before the cutoff newly
   * processable — hence the long retention.
   */
  private async purgePaymentEvents(): Promise<{
    examined: number;
    affected: number;
  }> {
    const createdAt = {
      lt: this.cutoff(
        this.config.get('maintenance.paymentEventRetentionDays', {
          infer: true,
        }),
      ),
    };
    const rows = await this.prisma.paymentEvent.findMany({
      where: { createdAt },
      orderBy: { createdAt: 'asc' },
      take: this.config.get('maintenance.purgeBatchSize', { infer: true }),
      select: { id: true },
    });
    const { count } = await this.prisma.paymentEvent.deleteMany({
      where: { id: { in: rows.map((r) => r.id) }, createdAt },
    });

    return { examined: rows.length, affected: count };
  }
}
