/**
 * Contract check: the request bodies the app sends, validated against the real
 * DTOs with the same ValidationPipe options as main.ts.
 *   npx ts-node --transpile-only -P tsconfig.json test/mfc.contract.check.ts
 */
import 'reflect-metadata';
import { ValidationPipe, type ArgumentMetadata } from '@nestjs/common';
import {
  MfcCreateRecordDto, MfcListingPrefillQueryDto, MfcPatchRecordDto, MfcPutLinesDto,
  MfcRecordListQueryDto, MfcSaveRecordDto,
} from '../src/modules/make-food-count/dto/mfc.dto';
import {
  MfcHomeImpactQueryDto, MfcInsightsQueryDto, MfcSourceParamDto,
} from '../src/modules/make-food-count/dto/mfc-insights.dto';

const pipe = new ValidationPipe({ whitelist: true, transform: true, forbidNonWhitelisted: true });
let failed = 0;
let expectedFailures = 0;

async function ok(name: string, metatype: new () => object, value: unknown,
                  type: 'body' | 'query' | 'param' = 'body') {
  try {
    await pipe.transform(value, { type, metatype } as ArgumentMetadata);
    console.log(`  ok   ${name}`);
  } catch (e: any) {
    failed += 1;
    console.log(`  FAIL ${name}: ${JSON.stringify(e?.response?.message ?? e?.message)}`);
  }
}

async function rejects(name: string, metatype: new () => object, value: unknown,
                       type: 'body' | 'query' | 'param' = 'body') {
  try {
    await pipe.transform(value, { type, metatype } as ArgumentMetadata);
    failed += 1;
    console.log(`  FAIL ${name}: should have been rejected`);
  } catch {
    expectedFailures += 1;
    console.log(`  ok   ${name} (rejected, as it should be)`);
  }
}

(async () => {
  console.log('-- what the app sends --');
  await ok('POST /mfc/records', MfcCreateRecordDto, {
    siteId: 1, clientRequestId: 'c-1', sources: ['OVERPRODUCTION', 'PLATE_SCRAPS'],
  });
  await ok('POST /mfc/records with a service date', MfcCreateRecordDto, {
    siteId: 1, clientRequestId: 'c-2', sources: ['SPOILAGE'],
    recordedAt: '2026-11-17T09:00:00.000Z',
  });
  await ok('PUT /mfc/records/:id/lines', MfcPutLinesDto, {
    version: 1,
    lines: [
      { clientKey: 'a', source: 'OVERPRODUCTION', category: 'meat_poultry',
        subtype: 'chicken', qtyKg: 5, fitForHumans: true },
      { clientKey: 'b', source: 'PLATE_SCRAPS', category: 'plate_scraps', qtyKg: 2.25 },
    ],
  });
  await ok('PUT lines, emptying the record', MfcPutLinesDto, { version: 3, lines: [] });
  await ok('PATCH /mfc/records/:id', MfcPatchRecordDto, { version: 2, sources: ['SPOILAGE'] });
  await ok('POST /mfc/records/:id/save', MfcSaveRecordDto, { version: 4 });
  await ok('GET /mfc/records', MfcRecordListQueryDto,
    { siteId: '1', status: 'SAVED', limit: '25' }, 'query');
  await ok('GET listing-prefill', MfcListingPrefillQueryDto, { kind: 'EDIBLE' }, 'query');
  await ok('GET /mfc/insights', MfcInsightsQueryDto,
    { from: '2026-11-01', to: '2026-11-30', siteId: '1' }, 'query');
  await ok('GET /mfc/insights/sources/:source', MfcSourceParamDto,
    { source: 'OVERPRODUCTION' }, 'param');
  await ok('GET /mfc/home-impact', MfcHomeImpactQueryDto, { siteId: '1' }, 'query');
  await ok('GET /mfc/home-impact, whole org', MfcHomeImpactQueryDto, {}, 'query');

  console.log('\n-- payloads that must be rejected --');
  await rejects('qtyKg of zero', MfcPutLinesDto, {
    version: 1, lines: [{ clientKey: 'a', source: 'SPOILAGE', category: 'dairy', qtyKg: 0 }] });
  await rejects('negative qtyKg', MfcPutLinesDto, {
    version: 1, lines: [{ clientKey: 'a', source: 'SPOILAGE', category: 'dairy', qtyKg: -1 }] });
  await rejects('three decimal places', MfcPutLinesDto, {
    version: 1, lines: [{ clientKey: 'a', source: 'SPOILAGE', category: 'dairy', qtyKg: 1.234 }] });
  await rejects('over the 500 kg line limit', MfcPutLinesDto, {
    version: 1, lines: [{ clientKey: 'a', source: 'SPOILAGE', category: 'dairy', qtyKg: 501 }] });
  await rejects('qtyKg that is not a number', MfcPutLinesDto, {
    version: 1, lines: [{ clientKey: 'a', source: 'SPOILAGE', category: 'dairy', qtyKg: 'abc' }] });
  await rejects('an unknown source', MfcPutLinesDto, {
    version: 1, lines: [{ clientKey: 'a', source: 'COMPOST', category: 'dairy', qtyKg: 1 }] });
  await rejects('create with no sources', MfcCreateRecordDto, {
    siteId: 1, clientRequestId: 'c-3', sources: [] });
  await rejects('create with no clientRequestId', MfcCreateRecordDto, {
    siteId: 1, sources: ['SPOILAGE'] });
  await rejects('a write with no version', MfcSaveRecordDto, {});
  await rejects('an unexpected extra field', MfcSaveRecordDto, { version: 1, sneaky: true });
  await rejects('insights with no range', MfcInsightsQueryDto, { siteId: 1 }, 'query');
  await rejects('an unknown listing kind', MfcListingPrefillQueryDto, { kind: 'BOTH' }, 'query');

  console.log(`\n${failed === 0 ? 'PASS' : 'FAIL'}: ${failed} unexpected failure(s); `
    + `${expectedFailures} payloads correctly rejected`);
  process.exit(failed === 0 ? 0 : 1);
})();
