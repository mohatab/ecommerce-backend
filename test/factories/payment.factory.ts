import { Payment, PaymentStatus, Prisma } from '@prisma/client';
import { PrismaService } from '../../src/prisma/prisma.service';

/** Same serial-suite caveat as the other factories. */
let sequence = 0;

/**
 * Builds a Payment row directly, bypassing initiation. Use it for read and
 * replay tests.
 *
 * NEVER use it to set an order to PAID for a webhook test: the webhook suite
 * must reach PAID through a signed event, or it proves nothing about the
 * pipeline it exists to test (spec §15.2).
 */
export async function createPayment(
  prisma: PrismaService,
  orderId: string,
  overrides: Partial<Prisma.PaymentUncheckedCreateInput> = {},
): Promise<Payment> {
  sequence += 1;

  return prisma.payment.create({
    data: {
      orderId,
      providerPaymentId: `factory_pi_${sequence}`,
      status: PaymentStatus.PENDING,
      ...overrides,
    },
  });
}
