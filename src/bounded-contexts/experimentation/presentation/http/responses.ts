import { ApiProperty } from '@nestjs/swagger';
import { RunDto, TrialDto, ClientRecordDto, TruthDto } from './dtos';
class StoredFields {
  @ApiProperty({ format: 'uuid' }) userId!: string;
  @ApiProperty({ format: 'date-time' }) recordedAt!: string;
}
export class StoredRun extends StoredFields {
  @ApiProperty({ type: RunDto }) input!: RunDto;
}
export class ExportTrialInput extends TrialDto {
  @ApiProperty({ format: 'uuid' }) runId!: string;
}
export class StoredTrial extends StoredFields {
  @ApiProperty({ type: ExportTrialInput }) input!: ExportTrialInput;
}
export class TruthInput extends TruthDto {
  @ApiProperty({ format: 'uuid' }) trialId!: string;
}
export class StoredTruth extends StoredFields {
  @ApiProperty({ type: TruthInput }) input!: TruthInput;
  @ApiProperty() revision!: number;
}
export class StoredClientRecord extends StoredFields {
  @ApiProperty({ type: ClientRecordDto }) input!: ClientRecordDto;
}
export class RunsPage {
  @ApiProperty({ type: [StoredRun] }) items!: StoredRun[];
  @ApiProperty() total!: number;
}
export class TrialsPage {
  @ApiProperty({ type: [StoredTrial] }) items!: StoredTrial[];
  @ApiProperty() total!: number;
}
export class IntegrityResponse {
  @ApiProperty({ enum: ['COMPLETO', 'INCOMPLETO', 'INCONSISTENTE'] }) status!: string;
  @ApiProperty({ type: [String] }) errors!: string[];
  @ApiProperty({ type: [String] }) warnings!: string[];
}
export class ExperimentalDataset {
  @ApiProperty({ enum: [1] }) schemaVersion!: number;
  @ApiProperty({ type: StoredRun }) run!: StoredRun;
  @ApiProperty({ type: [StoredTrial] }) trials!: StoredTrial[];
  @ApiProperty({ type: [StoredTruth] }) groundTruth!: StoredTruth[];
  @ApiProperty({ type: [StoredClientRecord] }) clientRecords!: StoredClientRecord[];
  @ApiProperty({
    type: 'array',
    items: { type: 'object', additionalProperties: true },
    description:
      'Snapshot normalizado, recibo original, todas as revisões e movimentos; dicionário em docs/experimentation.md.',
  })
  observations!: object[];
  @ApiProperty({
    type: 'array',
    items: { type: 'object', additionalProperties: true },
    description: 'observationId,revision,boundary,clockId,startMs,endMs; unidade ms, mesma origem.',
  })
  serverMeasurements!: object[];
}
export class ExperimentExport {
  @ApiProperty({ enum: [1] }) schemaVersion!: number;
  @ApiProperty({
    pattern: '^[0-9a-f]{64}$',
    description:
      'SHA-256 do dataset com chaves de objetos em ordem lexicográfica; arrays preservados.',
  })
  checksum!: string;
  @ApiProperty({ type: ExperimentalDataset }) dataset!: ExperimentalDataset;
  @ApiProperty({ type: IntegrityResponse }) integrity!: IntegrityResponse;
  @ApiProperty({
    type: 'array',
    items: { type: 'object', additionalProperties: true },
    description:
      'Contagens/durações por tentativa planejada, separando mode/dataKind; definições no dicionário.',
  })
  summary!: object[];
  @ApiProperty({
    type: 'array',
    items: { type: 'object', additionalProperties: true },
    description:
      'Razões com numerador/denominador explícitos; null sem população elegível. Separadas por dataKind/mode/tratamento/política, com clusters e durações em ms.',
  })
  metrics!: object[];
}
