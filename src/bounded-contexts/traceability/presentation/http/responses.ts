import { ApiProperty } from '@nestjs/swagger';
import { ObservationDto } from './dtos';
export { ApiSuccess } from '../../../../platform/http/api-response';

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
  @ApiProperty({
    type: 'object',
    properties: {
      tipo: { type: 'string', enum: ['AUTENTICADA', 'DECLARADA'] },
      usuarioId: { type: 'string', nullable: true },
      sessaoId: { type: 'string', nullable: true },
      perfil: { type: 'string', nullable: true },
    },
  })
  autoria!: Record<string, string | null>;
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
