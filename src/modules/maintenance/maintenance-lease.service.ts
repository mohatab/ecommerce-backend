import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Prisma } from '@prisma/client';
import { randomUUID } from 'node:crypto';
import { AppConfig } from '../../config/configuration';
import { PrismaService } from '../../prisma/prisma.service';
import { MaintenanceJobName } from './maintenance-job-name.enum';

/** Thrown inside a transaction when this instance no longer holds the lease. */
export class LeaseLostError extends Error {
  constructor(job: string) {
    super(`Maintenance lease for ${job} is no longer held by this instance`);
    this.name = 'LeaseLostError';
  }
}

export type AcquireOutcome = 'acquired' | 'held' | 'missing';

/**
 * Mutual exclusion for maintenance jobs, as a row rather than a PostgreSQL
 * advisory lock (spec D6, §9.3.1). `PrismaService` is a bare `PrismaClient`
 * with a connection pool and no pinning API, so a session-scoped
 * `pg_advisory_lock` could unlock on a different connection and leak — the
 * still-locked connection going back to the pool, the job dead until restart,
 * with no visible cause. And `pg_try_advisory_xact_lock` cannot cover the
 * execution window: the sweeps make provider calls outside transactions and
 * commit one transaction per order, so the window spans many transactions plus
 * network time. A row needs no connection affinity at all.
 *
 * The honest division of labour (§9.3.4): the lease prevents wasted duplicate
 * work, while `assertHeld()` and the per-row CAS prevent incorrect work.
 * Correctness never depends on the lease being perfectly exclusive.
 */
@Injectable()
export class MaintenanceLeaseService {
  /** Per-process identity. Two processes never share one. */
  readonly instanceId = randomUUID();

  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService<AppConfig, true>,
  ) {}

  private leaseMs(): number {
    return this.config.get('maintenance.leaseSeconds', { infer: true }) * 1000;
  }

  /**
   * The project's CAS idiom: the predicate travels with the write, so two
   * instances racing produce one `count === 1` and one `count === 0`. A read,
   * a check, then an update would let both pass the check.
   */
  async acquire(job: MaintenanceJobName): Promise<AcquireOutcome> {
    const now = new Date();
    const { count } = await this.prisma.maintenanceLease.updateMany({
      // Free, or lapsed. The migration seeds every row at the epoch, so the
      // first acquire of a job's lifetime matches here too and no code path
      // ever races on an INSERT.
      where: { job, expiresAt: { lte: now } },
      data: {
        holder: this.instanceId,
        acquiredAt: now,
        heartbeatAt: now,
        expiresAt: new Date(now.getTime() + this.leaseMs()),
      },
    });

    if (count === 1) {
      return 'acquired';
    }

    // Distinguish "someone holds it" from "the row is gone". The second is an
    // operational fault that would otherwise hide behind a routine warn and
    // leave the job silently unrunnable forever.
    //
    // A plain count, not `updateMany({ where: { job }, data: {} })`: Prisma
    // emits no statement for an empty `data` and returns `count: 0`, so that
    // probe reports every contended lease as 'missing'. Verified empirically
    // against PostgreSQL — two instances racing both got 'missing'.
    //
    // Racy by construction and deliberately so: this runs after the CAS has
    // already failed, and it only chooses which diagnostic to report.
    const exists = await this.prisma.maintenanceLease.count({ where: { job } });

    return exists === 1 ? 'held' : 'missing';
  }

  /** Renews only this instance's own lease, never a foreign one. */
  async heartbeat(job: MaintenanceJobName): Promise<boolean> {
    const now = new Date();
    const { count } = await this.prisma.maintenanceLease.updateMany({
      where: { job, holder: this.instanceId },
      data: {
        heartbeatAt: now,
        expiresAt: new Date(now.getTime() + this.leaseMs()),
      },
    });

    return count === 1;
  }

  /** Holder-scoped, so a late release cannot free another instance's lease. */
  async release(job: MaintenanceJobName): Promise<void> {
    await this.prisma.maintenanceLease.updateMany({
      where: { job, holder: this.instanceId },
      data: { holder: '', expiresAt: new Date(0) },
    });
  }

  /**
   * The fencing guarantee (spec §9.3.4). Called as the FIRST statement of
   * every mutating transaction, so the lease check and the mutation share one
   * transaction and an instance whose lease was taken over cannot commit.
   *
   * `tx` is REQUIRED and has no default, exactly as
   * `ProductsService.decrementStock(tx, …)` does. A version that reached for
   * `this.prisma` would run the check on a different connection outside the
   * caller's transaction, which guarantees nothing at all.
   */
  async assertHeld(
    tx: Prisma.TransactionClient,
    job: MaintenanceJobName,
  ): Promise<void> {
    const { count } = await tx.maintenanceLease.updateMany({
      where: { job, holder: this.instanceId, expiresAt: { gt: new Date() } },
      data: { heartbeatAt: new Date() },
    });

    if (count === 0) {
      throw new LeaseLostError(job);
    }
  }
}
