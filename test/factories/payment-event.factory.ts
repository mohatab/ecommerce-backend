import { PaymentEvent, Prisma } from '@prisma/client';
import { PrismaService } from '../../src/prisma/prisma.service';

/** Same serial-suite caveat as the other factories. */
let sequence = 0;

/** Builds a PaymentEvent row directly, for dedupe-precondition tests. */
export async function createPaymentEvent(
  prisma: PrismaService,
  providerEventId?: string,
  overrides: Partial<Prisma.PaymentEventUncheckedCreateInput> = {},
): Promise<PaymentEvent> {
  sequence += 1;

  return prisma.paymentEvent.create({
    data: {
      providerEventId: providerEventId ?? `factory_evt_${sequence}`,
      type: 'payment_intent.succeeded',
      ...overrides,
    },
  });
}
