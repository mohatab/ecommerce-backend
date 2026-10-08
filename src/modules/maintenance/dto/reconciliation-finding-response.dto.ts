import { ApiProperty } from '@nestjs/swagger';
import { Prisma, ReconciliationFinding } from '@prisma/client';
import { RECONCILIATION_FINDING_KINDS } from '../reconciliation-finding.writer';
// `import type` is required for a type used in a decorated property signature
// under isolatedModules + emitDecoratorMetadata (TS1272).
import type { ReconciliationFindingKind } from '../reconciliation-finding.writer';

/**
 * Controllers never return Prisma objects, so this mapper is the only path a
 * finding takes to a client. `@Exclude()` does nothing on Prisma's plain
 * objects, which is why the mapping is written out.
 *
 * `detail` is passed through because the WRITER is what keeps it safe: every
 * producer in `PaymentReconciliationService` builds it from ids, amounts,
 * currencies, and timestamps only — never a provider payload, never a
 * `clientSecret`, never a signature header (§8.4, §12). Sanitising again here
 * would imply the producers are not trusted, and a filter that has to guess
 * which keys are safe is worse than one closed set of producers.
 */
export class ReconciliationFindingResponseDto {
  @ApiProperty({ example: '0195f0a0-0000-7000-8000-000000000000' })
  orderId!: string;

  @ApiProperty({ nullable: true, example: null })
  paymentId!: string | null;

  @ApiProperty({
    enum: RECONCILIATION_FINDING_KINDS,
    example: RECONCILIATION_FINDING_KINDS.AMOUNT_MISMATCH,
  })
  kind!: ReconciliationFindingKind;

  @ApiProperty({
    example: 11,
    description: 'Total observations since firstSeenAt, never reset',
  })
  occurrences!: number;

  @ApiProperty()
  firstSeenAt!: Date;

  @ApiProperty()
  lastSeenAt!: Date;

  @ApiProperty({
    nullable: true,
    example: null,
    description: 'null means the divergence is still active',
  })
  resolvedAt!: Date | null;

  @ApiProperty({
    description: 'Ids, amounts, currencies, and timestamps only',
    example: {
      providerPaymentId: 'pi_123',
      providerAmountMinorUnits: 4999,
      orderTotalCents: 9998,
      observedAt: '2026-10-07T12:00:00.000Z',
    },
  })
  detail!: Prisma.JsonValue;

  static from(
    finding: ReconciliationFinding,
  ): ReconciliationFindingResponseDto {
    const dto = new ReconciliationFindingResponseDto();

    dto.orderId = finding.orderId;
    dto.paymentId = finding.paymentId;
    // The column is a plain String so a future kind cannot be blocked by an
    // enum migration; every value this application writes comes from
    // RECONCILIATION_FINDING_KINDS.
    dto.kind = finding.kind as ReconciliationFindingKind;
    dto.occurrences = finding.occurrences;
    dto.firstSeenAt = finding.firstSeenAt;
    dto.lastSeenAt = finding.lastSeenAt;
    dto.resolvedAt = finding.resolvedAt;
    dto.detail = finding.detail;

    return dto;
  }
}
