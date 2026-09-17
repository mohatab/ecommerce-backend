import {
  Controller,
  Get,
  Param,
  ParseUUIDPipe,
  Query,
  Req,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiOperation,
  ApiResponse,
  ApiTags,
} from '@nestjs/swagger';
import type { Request } from 'express';
import { OrdersService } from './orders.service';
import { OrderResponseDto } from './dto/order-response.dto';
import { PaginationQueryDto } from '../../common/dto/pagination-query.dto';
import { PaginatedDto } from '../../common/dto/paginated.dto';
import { ApiPaginatedResponse } from '../../common/swagger/api-paginated-response.decorator';

@ApiTags('orders')
@ApiBearerAuth()
@Controller('orders')
export class OrdersController {
  constructor(private readonly ordersService: OrdersService) {}

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
}
