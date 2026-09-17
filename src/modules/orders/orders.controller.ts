import {
  Controller,
  Get,
  Headers,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
  Req,
  Res,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiHeader,
  ApiOperation,
  ApiResponse,
  ApiTags,
} from '@nestjs/swagger';
import type { Request, Response } from 'express';
import { OrdersService } from './orders.service';
import { CheckoutService } from './checkout.service';
import { OrderResponseDto } from './dto/order-response.dto';
import { PaginationQueryDto } from '../../common/dto/pagination-query.dto';
import { PaginatedDto } from '../../common/dto/paginated.dto';
import { ApiPaginatedResponse } from '../../common/swagger/api-paginated-response.decorator';
import { IdempotencyKeyPipe } from '../../common/pipes/idempotency-key.pipe';

@ApiTags('orders')
@ApiBearerAuth()
@Controller('orders')
export class OrdersController {
  constructor(
    private readonly ordersService: OrdersService,
    private readonly checkoutService: CheckoutService,
  ) {}

  // request.user is guaranteed by the global JwtAuthGuard; neither route is
  // @Public().
  @Get()
  @ApiOperation({
    summary: "List the caller's orders",
    description: "Newest first. Only ever the authenticated caller's orders.",
  })
  @ApiPaginatedResponse(OrderResponseDto)
  @ApiResponse({ status: 401, description: 'Missing or invalid token' })
  async list(
    @Req() request: Request,
    @Query() query: PaginationQueryDto,
  ): Promise<PaginatedDto<OrderResponseDto>> {
    const { items, total } = await this.ordersService.listForUser(
      request.user!.sub,
      query,
    );

    return PaginatedDto.from(
      items.map((item) => OrderResponseDto.from(item)),
      total,
      query,
    );
  }

  @Get(':id')
  @ApiOperation({ summary: "Read one of the caller's orders" })
  @ApiResponse({ status: 200, description: 'The order' })
  @ApiResponse({ status: 401, description: 'Missing or invalid token' })
  @ApiResponse({
    status: 404,
    description: 'No such order, or it belongs to another user',
  })
  async findOne(
    @Req() request: Request,
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<OrderResponseDto> {
    return OrderResponseDto.from(
      await this.ordersService.findOneForUser(request.user!.sub, id),
    );
  }

  @Post()
  @ApiOperation({
    summary: "Check out the caller's cart",
    description:
      'Creates an order from the cart, decrementing stock atomically. ' +
      'Requires an Idempotency-Key header: replaying a key returns the ' +
      'original order with 200 instead of creating a second one.',
  })
  @ApiHeader({
    name: 'Idempotency-Key',
    required: true,
    description: '8-128 characters of A-Z, a-z, 0-9, _ or -',
  })
  @ApiResponse({ status: 201, description: 'Order created' })
  @ApiResponse({ status: 200, description: 'Idempotency key replayed' })
  @ApiResponse({ status: 400, description: 'Missing or malformed key' })
  @ApiResponse({ status: 401, description: 'Missing or invalid token' })
  @ApiResponse({
    status: 409,
    description: 'Empty cart, insufficient stock, or unavailable product',
  })
  @ApiResponse({
    status: 422,
    description: 'Mixed currencies, or a total beyond the supported maximum',
  })
  async checkout(
    @Req() request: Request,
    @Res({ passthrough: true }) response: Response,
    @Headers('idempotency-key') rawIdempotencyKey: unknown,
  ): Promise<OrderResponseDto> {
    // @Headers() has no pipe-argument overload (unlike @Param/@Query), so the
    // trust-boundary pipe is applied by hand here instead. It is stateless —
    // no constructor dependencies — so a fresh instance is equivalent to an
    // injected one.
    const idempotencyKey = new IdempotencyKeyPipe().transform(
      rawIdempotencyKey,
    );

    const result = await this.checkoutService.checkout(
      request.user!.sub,
      idempotencyKey,
    );

    // The status varies, so it is set here rather than with @HttpCode. The
    // service never touches the response object.
    response.status(result.replayed ? HttpStatus.OK : HttpStatus.CREATED);

    return OrderResponseDto.from(result.order);
  }
}
