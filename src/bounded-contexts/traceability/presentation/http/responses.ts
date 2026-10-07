import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
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
export class SdmConfigurationResponse {
  @ApiProperty({ enum: ['nfc-trace.sdm.encrypted-picc.v1'] }) perfil!: string;
  @ApiProperty({ example: true }) perfilCandidato!: boolean;
  @ApiProperty({ enum: ['ESTRITA', 'REGISTRO_TARDIO'] }) politica!: string;
  @ApiProperty({ format: 'uuid' }) referenciaChaves!: string;
  @ApiProperty({ enum: [1] }) versaoChaves!: number;
  @ApiProperty({ enum: [1] }) metaReadSlot!: number;
  @ApiProperty({ enum: [2] }) fileReadSlot!: number;
  @ApiProperty() uriTemplate!: string;
}
export class SdmDecisionResponse {
  @ApiProperty() perfil!: string;
  @ApiProperty({ enum: ['ESTRITA', 'REGISTRO_TARDIO'] }) politica!: string;
  @ApiProperty() epoca!: number;
  @ApiProperty() autenticada!: boolean;
  @ApiProperty() previamenteUtilizada!: boolean;
  @ApiProperty({ type: Number, nullable: true }) contador!: number | null;
  @ApiProperty({ type: Number, nullable: true }) maiorContadorAnterior!: number | null;
  @ApiProperty({ enum: ['NAO_AVALIADA', 'NOVA', 'TARDIA', 'REUTILIZADA'] }) temporalidade!: string;
}
export class ProvisioningResponse {
  @ApiPropertyOptional({ type: SdmConfigurationResponse }) sdm?: SdmConfigurationResponse;
  @ApiProperty({ format: 'uuid' }) id!: string;
  @ApiProperty({ format: 'uuid' }) etiquetaId!: string;
  @ApiProperty() uid!: string;
  @ApiProperty() modelo!: string;
  @ApiProperty({ format: 'uuid' }) pedidoId!: string;
  @ApiProperty({ enum: ['UID', 'NDEF_ESTATICO', 'SDM'] }) estrategia!: string;
  @ApiProperty() epoca!: number;
  @ApiProperty({ enum: ['REGISTRADA', 'ATIVA', 'DESPROVISIONADA'] }) status!: string;
  @ApiProperty({ type: String, nullable: true }) referenciaNdef!: string | null;
  @ApiProperty({ format: 'date-time' }) criadoEm!: string;
  @ApiProperty({ type: String, format: 'date-time', nullable: true }) ativadoEm!: string | null;
  @ApiProperty({ type: String, format: 'date-time', nullable: true }) encerradoEm!: string | null;
}
export class OrderDetailsResponse extends OrderResponse {
  @ApiProperty({
    type: ProvisioningResponse,
    nullable: true,
    description: 'Vínculo registrado ou ativo do pedido; null quando não há vínculo vigente.',
  })
  provisionamentoVigente!: ProvisioningResponse | null;
}
export class DecisionResponse {
  @ApiPropertyOptional({ type: SdmDecisionResponse }) sdm?: SdmDecisionResponse;
  @ApiProperty() autorizada!: boolean;
  @ApiProperty() motivo!: string;
  @ApiProperty({ enum: ['REGULAR', 'SUSPEITO'] }) classificacao!: string;
  @ApiProperty({ enum: ['IDENTIFICADA', 'INVALIDA', 'NAO_AVALIADA'] }) evidencia!: string;
  @ApiProperty() alterouEstado!: boolean;
  @ApiProperty({ type: String, nullable: true }) estadoAnterior!: string | null;
  @ApiProperty({ type: String, nullable: true }) estadoResultante!: string | null;
  @ApiProperty({ type: [String] }) avisos!: string[];
}
export class AuthorshipResponse {
  @ApiProperty({ enum: ['AUTENTICADA', 'DECLARADA'] }) tipo!: string;
  @ApiProperty({ type: String, format: 'uuid', nullable: true }) usuarioId!: string | null;
  @ApiProperty({ type: String, format: 'uuid', nullable: true }) sessaoId!: string | null;
  @ApiProperty({ type: String, nullable: true }) perfil!: string | null;
}
export class ObservationResponse extends ObservationDto {
  @ApiProperty({ type: AuthorshipResponse }) autoria!: AuthorshipResponse;
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
  @ApiProperty({ type: AuthorshipResponse, nullable: true }) autoria!: AuthorshipResponse | null;
  @ApiProperty({ type: DecisionResponse }) decisao!: DecisionResponse;
}

export class ObservationBatchItemResponse {
  @ApiProperty() indice!: number;
  @ApiProperty({ type: String, nullable: true }) id!: string | null;
  @ApiProperty() sucesso!: boolean;
  @ApiProperty() status!: number;
  @ApiProperty({ type: String, nullable: true }) codigo!: string | null;
  @ApiProperty() mensagem!: string;
  @ApiProperty({ type: ObservationResponse, nullable: true }) dados!: ObservationResponse | null;
}
export class ObservationBatchResponse {
  @ApiProperty({ type: [ObservationBatchItemResponse] }) itens!: ObservationBatchItemResponse[];
}
