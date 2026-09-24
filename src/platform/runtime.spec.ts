import { Sha256Fingerprint } from './runtime';
import { normalizeObservation } from '../bounded-contexts/traceability/application/record-observation';
import { ObservationInput } from '../bounded-contexts/traceability/domain/types';

describe('Observation identity', () => {
  it('ignores object key order while retaining changed evidence or context', () => {
    const hash = new Sha256Fingerprint();
    expect(hash.of({ a: 1, b: { x: 2, y: 3 } })).toBe(hash.of({ b: { y: 3, x: 2 }, a: 1 }));
    expect(hash.of({ tipo: 'COLETA' })).not.toBe(hash.of({ tipo: 'ENTREGA' }));
  });
  it('normalizes equivalent timestamps, UUID case, UID formatting and tech ordering', () => {
    const hash = new Sha256Fingerprint();
    const a: ObservationInput = {
      id: 'ABCD',
      versaoContrato: 1,
      provisionamentoId: 'EFGH',
      tipo: 'COLETA',
      ocorridoEm: '2026-09-24T09:00:00-03:00',
      dispositivoId: ' lab ',
      leituraBruta: { uid: '04:aa:bb:cc:dd:ee:01', tecnologias: ['NfcA', 'IsoDep'] },
    };
    const b: ObservationInput = {
      ...a,
      id: 'abcd',
      provisionamentoId: 'efgh',
      ocorridoEm: '2026-09-24T12:00:00.000Z',
      dispositivoId: 'lab',
      leituraBruta: { uid: '04AABBCCDDEE01', tecnologias: ['IsoDep', 'NfcA', 'NfcA'] },
    };
    expect(hash.of(normalizeObservation(a))).toBe(hash.of(normalizeObservation(b)));
  });
});
