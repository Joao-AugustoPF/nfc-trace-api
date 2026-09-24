import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { ESLint } from 'eslint';

const eslint = new ESLint();
const cases = [
  [
    'bounded-contexts/traceability/domain/probe.ts',
    'export { Injectable } from "@nestjs/common";',
    true,
  ],
  [
    'bounded-contexts/traceability/domain/probe.ts',
    'export const value = import("typeorm");',
    true,
  ],
  [
    'bounded-contexts/traceability/application/probe.ts',
    'export { Record } from "../infrastructure/records";',
    true,
  ],
  [
    'bounded-contexts/traceability/domain/probe.ts',
    'export { CreateOrder } from "../application/create-order";',
    true,
  ],
  ['shared-kernel/probe.ts', 'export { DataSource } from "typeorm";', true],
  [
    'bounded-contexts/traceability/infrastructure/probe.ts',
    'export { Other } from "../../other/domain/other";',
    true,
  ],
  [
    'bounded-contexts/traceability/domain/probe.ts',
    'export { DomainError } from "../../../shared-kernel/domain-error";',
    false,
  ],
  [
    'bounded-contexts/traceability/application/probe.ts',
    'export { Order } from "../domain/order";',
    false,
  ],
];

for (const [filename, code, shouldReject] of cases) {
  const [result] = await eslint.lintText(code, { filePath: resolve('src', filename) });
  const rejected = result.messages.some((message) => message.ruleId === 'architecture/boundaries');
  assert.equal(rejected, shouldReject, `Architecture rule: ${filename}: ${code}`);
}
console.log(`${cases.length} architectural boundary checks passed.`);
