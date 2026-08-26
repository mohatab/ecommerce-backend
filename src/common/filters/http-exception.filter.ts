import {
  ArgumentsHost,
  Catch,
  ExceptionFilter,
  HttpException,
  HttpStatus,
  Logger,
} from '@nestjs/common';
import { ThrottlerException } from '@nestjs/throttler';
import { Prisma } from '@prisma/client';
import { Request, Response } from 'express';

const SERVER_ERROR_THRESHOLD: number = HttpStatus.INTERNAL_SERVER_ERROR;

interface MappedPrismaError {
  statusCode: number;
  message: string;
  error: string;
}

const PRISMA_ERROR_MAP: Record<string, MappedPrismaError> = {
  P2002: {
    statusCode: HttpStatus.CONFLICT,
    message: 'A record with these values already exists',
    error: 'Conflict',
  },
  P2003: {
    statusCode: HttpStatus.CONFLICT,
    message: 'Related record constraint violated',
    error: 'Conflict',
  },
  P2025: {
    statusCode: HttpStatus.NOT_FOUND,
    message: 'The requested record was not found',
    error: 'Not Found',
  },
};

interface ErrorResponseBody {
  statusCode: number;
  message: string | string[];
  error: string;
  timestamp: string;
  path: string;
}

@Catch()
export class HttpExceptionFilter implements ExceptionFilter {
  private readonly logger = new Logger(HttpExceptionFilter.name);

  catch(exception: unknown, host: ArgumentsHost): void {
    const ctx = host.switchToHttp();
    const response = ctx.getResponse<Response>();
    const request = ctx.getRequest<Request>();

    const { statusCode, message, error } = this.resolveException(exception);

    const body: ErrorResponseBody = {
      statusCode,
      message,
      error,
      timestamp: new Date().toISOString(),
      path: request.url,
    };

    if (statusCode >= SERVER_ERROR_THRESHOLD) {
      this.logger.error(
        `${request.method} ${request.url} -> ${statusCode}`,
        exception instanceof Error ? exception.stack : undefined,
      );
    }

    response.status(statusCode).json(body);
  }

  private resolveException(exception: unknown): {
    statusCode: number;
    message: string | string[];
    error: string;
  } {
    // ThrottlerException extends HttpException with a bare string response
    // ('ThrottlerException: Too Many Requests'), which would otherwise fall
    // through to the generic string branch below and surface both `error`
    // and `message` as the raw library string — a class-name-bearing
    // internal detail, not the canonical reason phrase every other error in
    // this API uses. Both fields are hardcoded here rather than derived from
    // the exception.
    if (exception instanceof ThrottlerException) {
      return {
        statusCode: exception.getStatus(),
        message: 'Too Many Requests',
        error: 'Too Many Requests',
      };
    }

    if (exception instanceof HttpException) {
      const status = exception.getStatus();
      const response = exception.getResponse();

      if (typeof response === 'string') {
        return { statusCode: status, message: response, error: exception.name };
      }

      const responseObj = response as Record<string, unknown>;
      const message =
        (responseObj.message as string | string[] | undefined) ??
        exception.message;
      const error = (responseObj.error as string | undefined) ?? exception.name;

      return { statusCode: status, message, error };
    }

    if (exception instanceof Prisma.PrismaClientKnownRequestError) {
      const mapped = PRISMA_ERROR_MAP[exception.code];

      if (mapped) {
        return mapped;
      }
    }

    return {
      statusCode: HttpStatus.INTERNAL_SERVER_ERROR,
      message: 'Internal server error',
      error: 'Internal Server Error',
    };
  }
}
