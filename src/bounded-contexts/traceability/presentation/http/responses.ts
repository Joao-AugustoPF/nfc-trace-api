import { applyDecorators, Type } from '@nestjs/common';
import { ApiExtraModels, ApiProperty, ApiResponse, getSchemaPath } from '@nestjs/swagger';
import { ObservationDto } from './dtos';

export class OrderResponse {
  @ApiProperty({ format: 'uuid' }) id!: string;
  @ApiProperty() codigo!: string;
  @ApiProperty({ type: String, nullable: true }) descricao!: string | null;
  @ApiProperty({ enum: ['CADASTRADO', 'COLETADO', 'RECEBIDO', 'ENTREGUE'] }) estado!: string;
  @ApiProperty() expedido!: boolean;
  @ApiProperty() versao!: number;
  @ApiProperty({ format: 'date-time' }) criadoEm!: string;
}
export class ProvisioningResponse {
  @ApiProperty({ format: 'uuid' }) id!: string;
  @ApiProperty({ format: 'uuid' }) etiquetaId!: string;
  @ApiProperty() uid!: string;
  @ApiProperty() modelo!: string;
  @ApiProperty({ format: 'uuid' }) pedidoId!: string;
  @ApiProperty({ enum: ['UID', 'NDEF_ESTATICO'] }) estrategia!: string;
  @ApiProperty() epoca!: number;
  @ApiProperty({ enum: ['REGISTRADA', 'ATIVA', 'DESPROVISIONADA'] }) status!: string;
  @ApiProperty({ type: String, nullable: true }) referenciaNdef!: string | null;
  @ApiProperty({ format: 'date-time' }) criadoEm!: string;
  @ApiProperty({ type: String, format: 'date-time', nullable: true }) ativadoEm!: string | null;
  @ApiProperty({ type: String, format: 'date-time', nullable: true }) encerradoEm!: string | null;
}
export class DecisionResponse {
  @ApiProperty() autorizada!: boolean;
  @ApiProperty() motivo!: string;
  @ApiProperty({ enum: ['REGULAR', 'SUSPEITO'] }) classificacao!: string;
  @ApiProperty({ enum: ['IDENTIFICADA', 'INVALIDA', 'NAO_AVALIADA'] }) evidencia!: string;
  @ApiProperty() alterouEstado!: boolean;
  @ApiProperty({ type: String, nullable: true }) estadoAnterior!: string | null;
  @ApiProperty({ type: String, nullable: true }) estadoResultante!: string | null;
  @ApiProperty({ type: [String] }) avisos!: string[];
}
export class ObservationResponse extends ObservationDto {
  @ApiProperty({ example: true }) armazenada!: boolean;
  @ApiProperty({ type: String, format: 'uuid', nullable: true }) pedidoId!: string | null;
  @ApiProperty({ type: String, nullable: true }) estrategia!: string | null;
  @ApiProperty({ format: 'date-time' }) recebidoEm!: string;
  @ApiProperty({ type: DecisionResponse }) decisao!: DecisionResponse;
}
export class HistoryResponse {
  @ApiProperty({ format: 'uuid' }) id!: string;
  @ApiProperty() tipo!: string;
  @ApiProperty({ format: 'date-time' }) ocorridoEm!: string;
  @ApiProperty({ format: 'date-time' }) recebidoEm!: string;
  @ApiProperty({ format: 'uuid' }) provisionamentoId!: string;
  @ApiProperty({ enum: ['SISTEMA', 'CAPTURA'] }) origem!: string;
  @ApiProperty({ type: DecisionResponse }) decisao!: DecisionResponse;
}
export class ApiErrorResponse {
  @ApiProperty({ example: false }) sucesso!: boolean;
  @ApiProperty() mensagem!: string;
  @ApiProperty({ example: 'IDEMPOTENCIA_CONFLITO' }) codigo!: string;
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
    ...[400, 404, 409, 422, 500, 503].map((code) =>
      ApiResponse({ status: code, type: ApiErrorResponse }),
    ),
  );
}
