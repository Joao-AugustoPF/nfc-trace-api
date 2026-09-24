import { applyDecorators, Type } from '@nestjs/common';
import { ApiExtraModels, ApiProperty, ApiResponse, getSchemaPath } from '@nestjs/swagger';

export class ApiErrorResponse {
  @ApiProperty({ example: false }) sucesso!: boolean;
  @ApiProperty() mensagem!: string;
  @ApiProperty({ example: 'ACESSO_NEGADO' }) codigo!: string;
  @ApiProperty() correlacaoId!: string;
}
export function ApiSuccess(model: Type<unknown>, status = 200, paginated = false) {
  const dataSchema = paginated
    ? {
        type: 'object' as const,
        required: ['itens', 'total', 'pagina', 'limite'],
        properties: {
          itens: { type: 'array' as const, items: { $ref: getSchemaPath(model) } },
          total: { type: 'integer' as const },
          pagina: { type: 'integer' as const },
          limite: { type: 'integer' as const },
        },
      }
    : { $ref: getSchemaPath(model) };
  return applyDecorators(
    ApiExtraModels(model, ApiErrorResponse),
    ApiResponse({
      status,
      schema: {
        type: 'object',
        required: ['sucesso', 'mensagem', 'dados'],
        properties: {
          sucesso: { type: 'boolean', example: true },
          mensagem: { type: 'string' },
          dados: dataSchema,
        },
      },
    }),
    ...[400, 401, 403, 404, 409, 422, 429, 500, 503].map((code) =>
      ApiResponse({ status: code, type: ApiErrorResponse }),
    ),
  );
}
