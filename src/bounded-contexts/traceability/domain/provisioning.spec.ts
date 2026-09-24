import { Provisioning } from './provisioning';
import { evaluateReading } from './evaluate-reading';
import { ndefReference, normalizeUid } from './values';

const input = {
  id: 'provisioning',
  tagId: 'tag',
  orderId: 'order',
  strategy: 'NDEF_ESTATICO' as const,
  epoch: 1,
  createdAt: '2026-09-24T12:00:00.000Z',
};
const tag = { id: 'tag', uid: '04AABBCCDDEE01', model: 'NTAG424DNA', createdAt: input.createdAt };

describe('Provisioning and evidence rules', () => {
  it('requires the exact NDEF reference and supports idempotent activation/closure', () => {
    const provisioning = Provisioning.register(input);
    expect(() => provisioning.activate(input.createdAt, false)).toThrow();
    expect(() => provisioning.activate(input.createdAt, true, 'wrong')).toThrow();
    expect(provisioning.activate(input.createdAt, true, ndefReference(input.id))).toBe(true);
    expect(provisioning.activate(input.createdAt, true, ndefReference(input.id))).toBe(false);
    expect(provisioning.close(input.createdAt)).toBe(true);
    expect(provisioning.close(input.createdAt)).toBe(false);
    expect(() => provisioning.activate(input.createdAt, true, ndefReference(input.id))).toThrow();
  });
  it('flags UID divergence without strengthening the static NDEF baseline', () => {
    const provisioning = Provisioning.register(input).snapshot();
    const evidence = evaluateReading(provisioning, tag, {
      uid: '04AABBCCDDEE02',
      ndef: ndefReference(input.id),
    });
    expect(evidence).toMatchObject({
      valid: true,
      classification: 'SUSPEITO',
      warnings: ['UID_DIVERGENTE'],
    });
  });
  it('does not fall back to UID after NDEF failure, or to NDEF after UID failure', () => {
    const p = Provisioning.register(input).snapshot();
    expect(evaluateReading(p, tag, { uid: tag.uid, ndef: 'incorrect' }).valid).toBe(false);
    expect(
      evaluateReading({ ...p, strategy: 'UID' }, tag, {
        uid: '04AABBCCDDEE02',
        ndef: ndefReference(p.id),
      }).valid,
    ).toBe(false);
  });
  it('normalizes formatting but rejects malformed UIDs', () => {
    expect(normalizeUid('04:aa:bb:cc:dd:ee:01')).toBe(tag.uid);
    expect(() => normalizeUid('arbitrary')).toThrow();
  });
});
