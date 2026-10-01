import {
  Controller,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Post,
  Req,
  Res,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiOperation,
  ApiResponse,
  ApiTags,
} from '@nestjs/swagger';
import type { Request, Response } from 'express';
import { PaymentsService } from './payments.service';
import { PaymentResponseDto } from './dto/payment-response.dto';

/**
 * One trust posture per controller class (C7). Every route here is
 * bearer-authenticated and owner-scoped; the webhook lives in its own
 * @Public() controller so the two decorators are never adjacent.
 */
@ApiTags('payments')
@ApiBearerAuth()
@Controller('orders')
export class PaymentsController {
  constructor(private readonly paymentsService: PaymentsService) {}

  @Post(':id/payments')
  @ApiOperation({
    summary: 'Start paying for one of the caller’s orders',
    description:
      'Creates a payment intent for the order, or returns the existing one. ' +
      'The request body is empty by design: the amount and currency come ' +
      'from the persisted order and are never taken from the client. ' +
      'Repeating the request never creates a second intent. ' +
      'This endpoint does NOT complete the payment — completion happens ' +
      'out-of-band with the provider’s tooling, and only the signed ' +
      'webhook marks the order paid.',
  })
  @ApiResponse({ status: 201, description: 'Payment intent created' })
  @ApiResponse({ status: 200, description: 'Existing payment intent returned' })
  @ApiResponse({ status: 400, description: 'Malformed order id' })
  @ApiResponse({ status: 401, description: 'Missing or invalid token' })
  @ApiResponse({
    status: 404,
    description: 'No such order, or it belongs to another user',
  })
  @ApiResponse({
    status: 409,
    description: 'The order is cancelled, or already paid',
  })
  @ApiResponse({
    status: 422,
    description:
      'The order total is outside the payable range, or its currency is ' +
      'not supported for payment',
  })
  @ApiResponse({ status: 502, description: 'Payment provider unavailable' })
  async initiate(
    @Req() request: Request,
    @Res({ passthrough: true }) response: Response,
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<PaymentResponseDto> {
    // request.user is guaranteed by the global JwtAuthGuard; this route is
    // not @Public().
    const result = await this.paymentsService.initiate(request.user!.sub, id);

    // The status varies, so it is set here rather than with @HttpCode —
    // the same pattern OrdersController.checkout uses. The service never
    // touches the response object.
    response.status(result.created ? HttpStatus.CREATED : HttpStatus.OK);

    return PaymentResponseDto.from(result.payment, result.clientSecret);
  }
}
