import { randomBytes, randomUUID } from 'node:crypto';
import { deepStrictEqual } from 'node:assert';

// Simulated readings exercise HTTP only; they do not validate NFC hardware.
const base = process.env.API_URL ?? 'http://127.0.0.1:3000/api/v1';
async function call(path, body) {
  const response = await fetch(`${base}${path}`, {
    method: body === undefined ? 'GET' : 'POST',
    headers: { 'Content-Type': 'application/json', 'x-correlation-id': 'demo' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const result = await response.json();
  if (!response.ok) throw new Error(JSON.stringify(result));
  return result.dados;
}

const pedido = await call('/pedidos', {
  codigo: `DEMO-${randomUUID()}`,
  descricao: 'Leituras simuladas; sem etiqueta física.',
});
const etiqueta = await call('/etiquetas', {
  pedidoId: pedido.id,
  uid: randomBytes(7).toString('hex').toUpperCase(),
  modelo: 'SIMULADA',
  estrategia: 'NDEF_ESTATICO',
});
await call(`/provisionamentos/${etiqueta.id}/ativacao`, {
  bloqueioConfirmado: true,
  referenciaNdef: etiqueta.referenciaNdef,
});
for (const tipo of ['COLETA', 'MOVIMENTACAO', 'RECEBIMENTO', 'EXPEDICAO', 'ENTREGA']) {
  const input = {
    id: randomUUID(),
    versaoContrato: 1,
    provisionamentoId: etiqueta.id,
    tipo,
    ocorridoEm: new Date().toISOString(),
    dispositivoId: 'demo-simulador',
    leituraBruta: { uid: etiqueta.uid, ndef: etiqueta.referenciaNdef },
  };
  const result = await call('/eventos', input);
  if (!result.decisao.autorizada) throw new Error(JSON.stringify(result));
  const replay = await call('/eventos', input);
  deepStrictEqual(replay, result, 'Retransmission must preserve the persisted decision');
}
console.log(
  JSON.stringify(
    {
      pedido: await call(`/pedidos/${pedido.id}`),
      historico: await call(`/pedidos/${pedido.id}/eventos`),
    },
    null,
    2,
  ),
);
