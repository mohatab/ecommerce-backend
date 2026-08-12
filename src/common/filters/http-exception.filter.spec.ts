import { ArgumentsHost, BadRequestException, HttpStatus } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { HttpExceptionFilter } from './http-exception.filter';

interface ErrorBody {
  statusCode: number;
  message: string | string[];
  error: string;
  timestamp: string;
  path: string;
}

interface CapturedResponse {
  status: jest.Mock;
  json: jest.Mock<void, [ErrorBody]>;
}

function createHost(url = '/api/v1/widgets'): {
  host: ArgumentsHost;
  captured: CapturedResponse;
} {
  const json = jest.fn<void, [ErrorBody]>();
  const status = jest.fn().mockReturnValue({ json });

  const host = {
    switchToHttp: () => ({
      getResponse: () => ({ status }),
      getRequest: () => ({ url, method: 'POST' }),
    }),
  } as unknown as ArgumentsHost;

  return { host, captured: { status, json } };
}

function prismaError(code: string): Prisma.PrismaClientKnownRequestError {
  return new Prisma.PrismaClientKnownRequestError('database said no', {
    code,
    clientVersion: '6.19.3',
  });
}

describe('HttpExceptionFilter', () => {
  let filter: HttpExceptionFilter;

  beforeEach(() => {
    filter = new HttpExceptionFilter();
    jest.spyOn(console, 'error').mockImplementation(() => undefined);
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('maps P2002 unique violations to 409', () => {
    const { host, captured } = createHost();

    filter.catch(prismaError('P2002'), host);

    expect(captured.status).toHaveBeenCalledWith(HttpStatus.CONFLICT);
    expect(captured.json).toHaveBeenCalledWith(
      expect.objectContaining({
        statusCode: HttpStatus.CONFLICT,
        error: 'Conflict',
      }),
    );
  });

  it('maps P2025 missing records to 404', () => {
    const { host, captured } = createHost();

    filter.catch(prismaError('P2025'), host);

    expect(captured.status).toHaveBeenCalledWith(HttpStatus.NOT_FOUND);
  });

  it('maps P2003 foreign key violations to 409', () => {
    const { host, captured } = createHost();

    filter.catch(prismaError('P2003'), host);

    expect(captured.status).toHaveBeenCalledWith(HttpStatus.CONFLICT);
  });

  it('never leaks the raw Prisma message to the client', () => {
    const { host, captured } = createHost();

    filter.catch(prismaError('P2002'), host);

    const body = captured.json.mock.calls[0][0];
    expect(body.message).not.toContain('database said no');
  });

  it('maps unrecognised Prisma codes to a generic 500', () => {
    const { host, captured } = createHost();

    filter.catch(prismaError('P2037'), host);

    expect(captured.status).toHaveBeenCalledWith(
      HttpStatus.INTERNAL_SERVER_ERROR,
    );
    expect(captured.json).toHaveBeenCalledWith(
      expect.objectContaining({ message: 'Internal server error' }),
    );
  });

  it('still handles ordinary HttpExceptions', () => {
    const { host, captured } = createHost();

    filter.catch(new BadRequestException('bad input'), host);

    expect(captured.status).toHaveBeenCalledWith(HttpStatus.BAD_REQUEST);
  });

  it('includes the request path and a timestamp', () => {
    const { host, captured } = createHost('/api/v1/orders');

    filter.catch(new BadRequestException('bad input'), host);

    expect(captured.json).toHaveBeenCalledWith(
      expect.objectContaining({
        path: '/api/v1/orders',
        timestamp: expect.any(String) as string,
      }),
    );
  });
});
