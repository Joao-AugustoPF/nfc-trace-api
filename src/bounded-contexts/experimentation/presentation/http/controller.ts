import { Body, Controller, Get, Param, ParseUUIDPipe, Post, Query, HttpCode } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { ApiSuccess } from '../../../../platform/http/api-response';
import {
  ExperimentExport,
  RunsPage,
  TrialsPage,
  StoredRun,
  StoredTrial,
  StoredTruth,
  StoredClientRecord,
} from './responses';
import { AllowRoles, Principal } from '../../../../platform/access/http-security';
import { AuthenticatedActor, ROLES } from '../../../../shared-kernel/actor';
import { ExperimentService } from '../../application/experiment-service';
import { ClientRecordDto, PageDto, RunDto, TrialDto, TruthDto } from './dtos';

const uuid = new ParseUUIDPipe({ version: '4' });
@ApiTags('Experimentos')
@ApiBearerAuth()
@AllowRoles(...ROLES)
@Controller('experimentos')
export class ExperimentsController {
  constructor(private readonly experiments: ExperimentService) {}
  @Post()
  @ApiSuccess(StoredRun, 201)
  @AllowRoles('ADMINISTRADOR')
  @ApiOperation({ summary: 'Planejar execução; versões/configurações declaradas, sem credenciais' })
  create(@Body() body: RunDto, @Principal() actor: AuthenticatedActor) {
    return this.experiments.createRun(body, actor);
  }
  @Get() @ApiSuccess(RunsPage) list(@Query() page: PageDto) {
    return this.experiments.runs(page.pagina, page.limite);
  }
  @Post(':id/tentativas')
  @ApiSuccess(StoredTrial, 201)
  @AllowRoles('ADMINISTRADOR')
  trial(
    @Param('id', uuid) id: string,
    @Body() body: TrialDto,
    @Principal() actor: AuthenticatedActor,
  ) {
    return this.experiments.createTrial({ ...body, runId: id.toLowerCase() }, actor);
  }
  @Get(':id/tentativas') @ApiSuccess(TrialsPage) trials(
    @Param('id', uuid) id: string,
    @Query() page: PageDto,
  ) {
    return this.experiments.trials(id.toLowerCase(), page.pagina, page.limite);
  }
  @Post('tentativas/:id/observacao-independente')
  @ApiSuccess(StoredTruth, 201)
  @AllowRoles('ADMINISTRADOR')
  @ApiOperation({ summary: 'Acrescentar ground truth do observador; correções geram nova revisão' })
  truth(
    @Param('id', uuid) id: string,
    @Body() body: TruthDto,
    @Principal() actor: AuthenticatedActor,
  ) {
    return this.experiments.groundTruth({ ...body, trialId: id.toLowerCase() }, actor);
  }
  @Post('registros')
  @ApiSuccess(StoredClientRecord)
  @HttpCode(200)
  @AllowRoles('ADMINISTRADOR', 'OPERADOR')
  @ApiOperation({
    summary: 'Guardar estágio imutável; mesmo UUID/conteúdo retorna o registro original',
  })
  record(@Body() body: ClientRecordDto, @Principal() actor: AuthenticatedActor) {
    return this.experiments.record(body, actor);
  }
  @Get(':id/exportacao')
  @AllowRoles('ADMINISTRADOR')
  @ApiOperation({
    summary: 'Snapshot JSON versionado, checksum SHA-256, integridade e métricas',
    description:
      'Leitura sem alterar dados. Campos de dataset em inglês são o contrato de exportação v1. Dados sintéticos não constituem aceite físico.',
  })
  @ApiSuccess(ExperimentExport)
  export(@Param('id', uuid) id: string, @Principal() actor: AuthenticatedActor) {
    return this.experiments.export(id.toLowerCase(), actor);
  }
}
