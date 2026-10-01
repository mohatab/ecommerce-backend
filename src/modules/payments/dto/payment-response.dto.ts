import { ApiProperty } from '@nestjs/swagger';
import { Payment, PaymentStatus } from '@prisma/client';

export class PaymentResponseDto {
  @ApiProperty({ example: '0195f0a0-0000-7000-8000-000000000000' })
  id!: string;

  @ApiProperty({ example: '0195f0a0-0000-7000-8000-000000000001' })
  orderId!: string;

  @ApiProperty({ enum: PaymentStatus, example: PaymentStatus.PENDING })
  status!: PaymentStatus;

  @ApiProperty({
    example: 'pi_3Ab_secret_9Cd',
    description:
      'Hand this to the payment provider’s client tooling to complete the ' +
      'payment. This API never completes it: the signed webhook is the only ' +
      'thing that marks the order paid.',
  })
  clientSecret!: string;

  @ApiProperty()
  createdAt!: Date;

  /**
   * providerPaymentId is deliberately NOT exposed — nothing consumes it.
   * That is YAGNI, not secrecy: the client secret embeds the intent id, so
   * omitting the field is not a security measure and must not be described
   * as one.
   */
  static from(payment: Payment, clientSecret: string): PaymentResponseDto {
    const dto = new PaymentResponseDto();

    dto.id = payment.id;
    dto.orderId = payment.orderId;
    dto.status = payment.status;
    dto.clientSecret = clientSecret;
    dto.createdAt = payment.createdAt;

    return dto;
  }
}
