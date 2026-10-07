import {
  Body,
  Controller,
  Get,
  Headers,
  HttpCode,
  Logger,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { DomainError } from '../../../../shared-kernel/domain-error';
import { AuthenticatedActor, ROLES } from '../../../../shared-kernel/actor';
import { AllowRoles, Principal } from '../../../../platform/access/http-security';
import { CreateOrder } from '../../application/create-order';
import { ProvisionTag } from '../../application/provision-tag';
import { ActivateProvisioning, CloseProvisioning } from '../../application/change-provisioning';
import { RecordObservation } from '../../application/record-observation';
import { TraceabilityQueries } from '../../application/queries';
import {
  ActivationDto,
  CreateOrderDto,
  ObservationDto,
  ObservationBatchDto,
  OrderSearchDto,
  PaginationDto,
  ProvisionTagDto,
} from './dtos';
import {
  ApiSuccess,
  HistoryResponse,
  ObservationResponse,
  ObservationBatchResponse,
  ObservationBatchItemResponse,
  OrderResponse,
  OrderDetailsResponse,
  ProvisioningResponse,
} from './responses';

const uuid = new ParseUUIDPipe({ version: '4' });

@ApiTags('Pedidos')
@ApiBearerAuth()
@AllowRoles(...ROLES)
@Controller('pedidos')
export class OrdersController {
  constructor(
    private readonly create: CreateOrder,
    private readonly queries: TraceabilityQueries,
  ) {}
  @Post()
  @AllowRoles('ADMINISTRADOR')
  @ApiSuccess(OrderResponse, 201)
  createOrder(
    @Body() body: CreateOrderDto,
    @Headers('x-correlation-id') correlationId: string,
    @Principal() actor: AuthenticatedActor,
  ) {
    return this.create.execute(body, correlationId, actor);
  }
  @Get()
  @ApiSuccess(OrderResponse, 200, true)
  list(@Query() query: OrderSearchDto) {
    return this.queries.orders(query.busca, { page: query.pagina, limit: query.limite });
  }
  @Get(':id')
  @ApiSuccess(OrderDetailsResponse)
  get(@Param('id', uuid) id: string) {
    return this.queries.order(id);
  }
  @Get(':id/eventos')
  @ApiSuccess(HistoryResponse, 200, true)
  history(@Param('id', uuid) id: string, @Query() query: PaginationDto) {
    return this.queries.history(id, { page: query.pagina, limit: query.limite });
  }
}

@ApiTags('Etiquetas')
@ApiBearerAuth()
@AllowRoles(...ROLES)
@Controller('etiquetas')
export class TagsController {
  constructor(
    private readonly provision: ProvisionTag,
    private readonly queries: TraceabilityQueries,
  ) {}
  @Post()
  @AllowRoles('ADMINISTRADOR')
  @ApiSuccess(ProvisioningResponse, 201)
  register(
    @Body() body: ProvisionTagDto,
    @Headers('x-correlation-id') correlationId: string,
    @Principal() actor: AuthenticatedActor,
  ) {
    return this.provision.execute(body, correlationId, actor);
  }
  @Get(':uid')
  @ApiSuccess(ProvisioningResponse)
  get(@Param('uid') uid: string) {
    return this.queries.tag(uid);
  }
}

@ApiTags('Provisionamentos')
@ApiBearerAuth()
@AllowRoles(...ROLES)
@Controller('provisionamentos')
export class ProvisioningsController {
  constructor(
    private readonly activate: ActivateProvisioning,
    private readonly close: CloseProvisioning,
    private readonly queries: TraceabilityQueries,
  ) {}
  @Get(':id')
  @ApiSuccess(ProvisioningResponse)
  get(@Param('id', uuid) id: string) {
    return this.queries.provisioning(id);
  }
  @Post(':id/ativacao')
  @AllowRoles('ADMINISTRADOR')
  @HttpCode(200)
  @ApiSuccess(ProvisioningResponse)
  activateTag(
    @Param('id', uuid) id: string,
    @Body() body: ActivationDto,
    @Headers('x-correlation-id') correlationId: string,
    @Principal() actor: AuthenticatedActor,
  ) {
    return this.activate.execute(id, body, correlationId, actor);
  }
  @Post(':id/encerramento')
  @AllowRoles('ADMINISTRADOR')
  @HttpCode(200)
  @ApiSuccess(ProvisioningResponse)
  closeTag(
    @Param('id', uuid) id: string,
    @Headers('x-correlation-id') correlationId: string,
    @Principal() actor: AuthenticatedActor,
  ) {
    return this.close.execute(id, correlationId, actor);
  }
}

@ApiTags('Eventos')
@ApiBearerAuth()
@AllowRoles(...ROLES)
@Controller('eventos')
export class ObservationsController {
  private readonly logger = new Logger(ObservationsController.name);
  constructor(
    private readonly record: RecordObservation,
    private readonly queries: TraceabilityQueries,
  ) {}
  @Post()
  @AllowRoles('ADMINISTRADOR', 'OPERADOR')
  @HttpCode(200)
  @ApiSuccess(ObservationResponse)
  @ApiOperation({
    summary: 'Armazenar captura e recuperar decisão idempotente',
    description:
      'HTTP 200 confirma armazenamento. Consulte dados.decisao.autorizada para a operação logística.',
  })
  capture(
    @Body() body: ObservationDto,
    @Headers('x-correlation-id') correlationId: string,
    @Principal() actor: AuthenticatedActor,
  ) {
    return this.record.execute(body, correlationId, actor);
  }
  @Post('lote')
  @AllowRoles('ADMINISTRADOR', 'OPERADOR')
  @HttpCode(200)
  @ApiSuccess(ObservationBatchResponse)
  @ApiOperation({
    summary: 'Sincronizar até 50 capturas com resultado por item',
    description:
      'Cada item tem transação/idempotência próprias. HTTP 200 confirma processamento do lote, não armazenamento ou autorização de todos os itens. Erros de entrada não impedem os demais. A ordem é preservada; reordenação logística pertence à reconciliação futura.',
  })
  async batch(
    @Body() body: ObservationBatchDto,
    @Headers('x-correlation-id') correlationId: string,
    @Principal() actor: AuthenticatedActor,
  ): Promise<ObservationBatchResponse> {
    const itens: ObservationBatchItemResponse[] = [];
    for (const [indice, raw] of body.itens.entries()) {
      const id =
        raw &&
        typeof raw === 'object' &&
        'id' in raw &&
        typeof raw.id === 'string' &&
        /^[0-9a-f-]{36}$/i.test(raw.id)
          ? raw.id.toLowerCase()
          : null;
      const errorItem = (status: number, codigo: string, mensagem: string) => ({
        indice,
        id,
        sucesso: false,
        status,
        codigo,
        mensagem,
        dados: null,
      });
      if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
        itens.push(errorItem(400, 'ENTRADA_INVALIDA', 'Confira os campos e formatos enviados.'));
        continue;
      }
      try {
        const input = plainToInstance(ObservationDto, raw);
        const errors = await validate(input, {
          whitelist: true,
          forbidNonWhitelisted: true,
          forbidUnknownValues: true,
          validationError: { target: false, value: false },
        });
        if (errors.length) {
          itens.push(errorItem(400, 'ENTRADA_INVALIDA', 'Confira os campos e formatos enviados.'));
          continue;
        }
        const dados = await this.record.execute(input, correlationId, actor);
        itens.push({
          indice,
          id: input.id,
          sucesso: true,
          status: 200,
          codigo: null,
          mensagem: 'Captura armazenada. Consulte a decisão logística.',
          dados,
        });
      } catch (error) {
        if (error instanceof DomainError) {
          const status = {
            validation: 400,
            'not-found': 404,
            conflict: 409,
            unsupported: 422,
            unavailable: 503,
          }[error.kind];
          itens.push(errorItem(status, error.code, error.message));
        } else {
          this.logger.error({
            event: 'batch_item_failed',
            correlationId,
            indice,
            observationId: id,
            errorType: error instanceof Error ? error.name : 'UnknownError',
          });
          itens.push(errorItem(500, 'ERRO_INTERNO', 'Falha temporária ao processar esta captura.'));
        }
      }
    }
    return { itens };
  }
  @Get(':id')
  @ApiSuccess(ObservationResponse)
  get(@Param('id', uuid) id: string) {
    return this.queries.observation(id.toLowerCase());
  }
}
