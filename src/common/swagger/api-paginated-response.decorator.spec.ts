import { Controller, Get } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { ApiProperty, DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import { ApiPaginatedResponse } from './api-paginated-response.decorator';
import { PaginatedDto } from '../dto/paginated.dto';

class WidgetDto {
  @ApiProperty()
  id!: string;
}

@Controller('widgets')
class WidgetsController {
  @Get()
  @ApiPaginatedResponse(WidgetDto)
  findAll(): PaginatedDto<WidgetDto> {
    return PaginatedDto.from<WidgetDto>([], 0, { page: 1, limit: 20 });
  }
}

describe('ApiPaginatedResponse', () => {
  it('documents data as an array of the given model', async () => {
    const moduleRef = await Test.createTestingModule({
      controllers: [WidgetsController],
    }).compile();
    const app = moduleRef.createNestApplication();
    await app.init();

    const document = SwaggerModule.createDocument(
      app,
      new DocumentBuilder().setTitle('t').setVersion('1').build(),
    );

    const widgetsPath = JSON.stringify(document.paths['/widgets']);

    expect(widgetsPath).toContain('#/components/schemas/PaginatedDto');
    expect(widgetsPath).toContain('#/components/schemas/WidgetDto');
    expect(widgetsPath).toContain('#/components/schemas/PaginationMetaDto');
    expect(document.components?.schemas?.WidgetDto).toBeDefined();

    await app.close();
  });
});
