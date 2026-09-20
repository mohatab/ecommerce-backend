import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Put,
  Req,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiOperation,
  ApiResponse,
  ApiTags,
} from '@nestjs/swagger';
import type { Request } from 'express';
import { CartService } from './cart.service';
import { SetCartItemDto } from './dto/set-cart-item.dto';
import { CartResponseDto } from './dto/cart-response.dto';

@ApiTags('cart')
@ApiBearerAuth()
@Controller('cart')
export class CartController {
  constructor(private readonly cartService: CartService) {}

  // request.user is guaranteed by the global JwtAuthGuard; none of these
  // routes is @Public().
  @Get()
  @ApiOperation({
    summary: "Read the caller's cart",
    description: 'Does not create a cart. An absent cart reads as empty.',
  })
  @ApiResponse({ status: 200, description: 'The cart' })
  @ApiResponse({ status: 401, description: 'Missing or invalid token' })
  async get(@Req() request: Request): Promise<CartResponseDto> {
    return CartResponseDto.from(
      await this.cartService.getForUser(request.user!.sub),
    );
  }

  @Put('items/:productId')
  @ApiOperation({
    summary: 'Set the quantity of one product in the cart',
    description:
      'Assigns the quantity; it does not add to the existing line. ' +
      'Repeating the same request leaves the same state.',
  })
  @ApiResponse({ status: 200, description: 'The updated cart' })
  @ApiResponse({ status: 400, description: 'Quantity outside 1-99' })
  @ApiResponse({ status: 401, description: 'Missing or invalid token' })
  @ApiResponse({ status: 404, description: 'No such active product' })
  @ApiResponse({ status: 422, description: 'Cart line limit reached' })
  async setItem(
    @Req() request: Request,
    @Param('productId', ParseUUIDPipe) productId: string,
    @Body() dto: SetCartItemDto,
  ): Promise<CartResponseDto> {
    return CartResponseDto.from(
      await this.cartService.setItem(
        request.user!.sub,
        productId,
        dto.quantity,
      ),
    );
  }

  @Delete('items/:productId')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({
    summary: 'Remove one product from the cart',
    description: 'Idempotent: removing an absent line also returns 204.',
  })
  @ApiResponse({ status: 204, description: 'Removed' })
  @ApiResponse({ status: 401, description: 'Missing or invalid token' })
  async removeItem(
    @Req() request: Request,
    @Param('productId', ParseUUIDPipe) productId: string,
  ): Promise<void> {
    await this.cartService.removeItem(request.user!.sub, productId);
  }
}
