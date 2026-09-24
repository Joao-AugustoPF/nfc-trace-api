import { randomUUID } from 'node:crypto';
import {
  ArgumentsHost,
  CallHandler,
  Catch,
  ExceptionFilter,
  ExecutionContext,
  HttpException,
  Logger,
  NestInterceptor,
  ValidationPipe,
  RequestMethod,
} from '@nestjs/common';
import { INestApplication } from '@nestjs/common';
import { Request, Response, NextFunction, json } from 'express';
import { Observable, map } from 'rxjs';
import { DomainError } from '../shared-kernel/domain-error';

@Catch()
export class ApiExceptionFilter implements ExceptionFilter {
  private readonly logger = new Logger(ApiExceptionFilter.name);
  catch(error: unknown, host: ArgumentsHost): void {
    const request = host.switchToHttp().getRequest<Request>();
    const response = host.switchToHttp().getResponse<Response>();
    let status = 500;
    let code = 'ERRO_INTERNO';
    let message = 'Falha interna ao processar a solicitação.';
    if (error instanceof DomainError) {
      status = { validation: 400, 'not-found': 404, conflict: 409, unsupported: 422 }[error.kind];
      code = error.code;
      message = error.message;
    } else if (
      error &&
      typeof error === 'object' &&
      'type' in error &&
      (error.type === 'entity.too.large' || error.type === 'entity.parse.failed')
    ) {
      status = error.type === 'entity.too.large' ? 413 : 400;
      code = status === 413 ? 'PAYLOAD_EXCEDIDO' : 'ENTRADA_INVALIDA';
      message = status === 413 ? 'O corpo excede 32 KiB.' : 'O corpo deve conter JSON válido.';
    } else if (error instanceof HttpException) {
      status = error.getStatus();
      code =
        (
          {
            400: 'ENTRADA_INVALIDA',
            404: 'ROTA_NAO_ENCONTRADA',
            413: 'PAYLOAD_EXCEDIDO',
            503: 'SERVICO_INDISPONIVEL',
          } as Record<number, string>
        )[status] ?? `HTTP_${status}`;
      message = status === 400 ? 'Confira os campos e formatos enviados.' : error.message;
    } else {
      this.logger.error({
        event: 'request_failed',
        correlationId: request.headers['x-correlation-id'],
        errorType: error instanceof Error ? error.name : 'UnknownError',
      });
    }
    response.status(status).json({
      sucesso: false,
      codigo: code,
      mensagem: message,
      correlacaoId: request.headers['x-correlation-id'],
    });
  }
}

class EnvelopeInterceptor implements NestInterceptor {
  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    const request = context.switchToHttp().getRequest<Request>();
    if (!request.path.startsWith('/api/')) return next.handle();
    return next
      .handle()
      .pipe(map((dados) => ({ sucesso: true, mensagem: 'Solicitação processada.', dados })));
  }
}

export function configureHttp(app: INestApplication): void {
  const logger = new Logger('Http');
  app.use((request: Request, response: Response, next: NextFunction) => {
    const incoming = request.headers['x-correlation-id'];
    const id =
      typeof incoming === 'string' && /^[a-zA-Z0-9_.:-]{1,100}$/.test(incoming)
        ? incoming
        : randomUUID();
    request.headers['x-correlation-id'] = id;
    response.setHeader('x-correlation-id', id);
    const start = performance.now();
    response.on('finish', () =>
      logger.log({
        event: 'http_request',
        correlationId: id,
        method: request.method,
        route: request.route?.path ?? 'unmatched',
        status: response.statusCode,
        durationMs: Number((performance.now() - start).toFixed(2)),
      }),
    );
    next();
  });
  app.use(json({ limit: '32kb' }));
  app.setGlobalPrefix('api/v1', {
    exclude: [
      { path: 'health/live', method: RequestMethod.GET },
      { path: 'health/ready', method: RequestMethod.GET },
      { path: 'metrics', method: RequestMethod.GET },
    ],
  });
  app.useGlobalPipes(
    new ValidationPipe({
      transform: true,
      whitelist: true,
      forbidNonWhitelisted: true,
      forbidUnknownValues: true,
      validationError: { target: false, value: false },
    }),
  );
  app.useGlobalFilters(new ApiExceptionFilter());
  app.useGlobalInterceptors(new EnvelopeInterceptor());
}
