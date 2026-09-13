import { Controller, Get, Param, ParseUUIDPipe, Query } from '@nestjs/common';
import { ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import { ProductsService } from './products.service';
import { ProductListQueryDto } from './dto/product-list-query.dto';
import { ProductResponseDto } from './dto/product-response.dto';
import { PaginatedDto } from '../../common/dto/paginated.dto';
import { ApiPaginatedResponse } from '../../common/swagger/api-paginated-response.decorator';
import { Public } from '../../common/decorators/public.decorator';

@ApiTags('products')
@Controller('products')
export class ProductsController {
  constructor(private readonly productsService: ProductsService) {}

  @Public()
  @Get()
  @ApiOperation({ summary: 'List active products' })
  @ApiPaginatedResponse(ProductResponseDto)
  @ApiResponse({
    status: 400,
    description: 'Invalid pagination, filter, or sort value',
  })
  async list(
    @Query() query: ProductListQueryDto,
  ): Promise<PaginatedDto<ProductResponseDto>> {
    // 'active-only' is passed explicitly on every public read. The service
    // has no default; that is the point.
    const { items, total } = await this.productsService.list(
      query,
      'active-only',
    );

    return PaginatedDto.from(
      items.map((item) => ProductResponseDto.from(item)),
      total,
      query,
    );
  }

  @Public()
  @Get(':id')
  @ApiOperation({ summary: 'Fetch one active product' })
  @ApiResponse({ status: 200, description: 'The product' })
  @ApiResponse({
    status: 404,
    description:
      'No active product with that id — a deactivated product reads as absent',
  })
  async findOne(
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<ProductResponseDto> {
    return ProductResponseDto.from(
      await this.productsService.findOne(id, 'active-only'),
    );
  }
}
