import {
  Body,
  Controller,
  Delete,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiOperation,
  ApiResponse,
  ApiTags,
} from '@nestjs/swagger';
import { Role } from '@prisma/client';
import { ProductsService } from './products.service';
import { CreateProductDto } from './dto/create-product.dto';
import { UpdateProductDto } from './dto/update-product.dto';
import { AdjustStockDto } from './dto/adjust-stock.dto';
import { ProductResponseDto } from './dto/product-response.dto';
import { Roles } from '../../common/decorators/roles.decorator';

/**
 * Every route here is admin-only through ONE class-level decorator. That is
 * the point of the split controller: the likeliest authorization defect in
 * this phase is a write route that forgets @Roles(), and a class-level
 * decorator turns several chances to forget into one.
 */
@ApiTags('admin-products')
@ApiBearerAuth()
@Roles(Role.ADMIN)
@Controller('admin/products')
export class AdminProductsController {
  constructor(private readonly productsService: ProductsService) {}

  @Post()
  @ApiOperation({ summary: 'Create a product' })
  @ApiResponse({ status: 201, description: 'Created' })
  @ApiResponse({ status: 400, description: 'Validation failed' })
  @ApiResponse({ status: 401, description: 'Missing or invalid token' })
  @ApiResponse({
    status: 403,
    description: 'Authenticated but not an administrator',
  })
  @ApiResponse({
    status: 409,
    description: 'categoryId does not reference an existing category',
  })
  async create(@Body() dto: CreateProductDto): Promise<ProductResponseDto> {
    return ProductResponseDto.from(
      await this.productsService.create({
        name: dto.name,
        description: dto.description,
        priceCents: dto.priceCents,
        currency: dto.currency ?? 'USD',
        imageUrl: dto.imageUrl,
        categoryId: dto.categoryId,
        stockQuantity: dto.stockQuantity ?? 0,
      }),
    );
  }

  @Patch(':id')
  @ApiOperation({
    summary: 'Update a product',
    description: 'Send { "isActive": true } to restore a deactivated product.',
  })
  @ApiResponse({ status: 200, description: 'Updated' })
  @ApiResponse({ status: 401, description: 'Missing or invalid token' })
  @ApiResponse({
    status: 403,
    description: 'Authenticated but not an administrator',
  })
  @ApiResponse({ status: 404, description: 'No product with that id' })
  @ApiResponse({
    status: 409,
    description: 'categoryId does not reference an existing category',
  })
  async update(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateProductDto,
  ): Promise<ProductResponseDto> {
    return ProductResponseDto.from(await this.productsService.update(id, dto));
  }

  @Delete(':id')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({
    summary: 'Deactivate a product (soft delete)',
    description:
      'Sets isActive to false. The row is never removed, so historical ' +
      'orders keep valid product references. Restore with ' +
      'PATCH { "isActive": true }.',
  })
  @ApiResponse({ status: 204, description: 'Deactivated' })
  @ApiResponse({ status: 401, description: 'Missing or invalid token' })
  @ApiResponse({
    status: 403,
    description: 'Authenticated but not an administrator',
  })
  @ApiResponse({ status: 404, description: 'No product with that id' })
  async deactivate(@Param('id', ParseUUIDPipe) id: string): Promise<void> {
    await this.productsService.deactivate(id);
  }

  @Post(':id/stock-adjustments')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Adjust stock by a relative amount',
    description:
      'Applies a signed delta. Relative rather than absolute so a concurrent ' +
      'sale cannot be silently overwritten. Returns the product with its new ' +
      'stock level, which a relative operation makes otherwise unguessable.',
  })
  @ApiResponse({ status: 200, description: 'Adjusted' })
  @ApiResponse({ status: 400, description: 'Validation failed' })
  @ApiResponse({ status: 401, description: 'Missing or invalid token' })
  @ApiResponse({
    status: 403,
    description: 'Authenticated but not an administrator',
  })
  @ApiResponse({ status: 404, description: 'No product with that id' })
  @ApiResponse({
    status: 409,
    description: 'The adjustment would take stock below zero',
  })
  async adjustStock(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: AdjustStockDto,
  ): Promise<ProductResponseDto> {
    return ProductResponseDto.from(
      await this.productsService.adjustStock(id, dto.delta),
    );
  }
}
