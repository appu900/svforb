/**
 * Contract check: the request bodies the mobile app sends, validated against
 * the real DTOs with the same ValidationPipe options as main.ts.
 *   npx ts-node --transpile-only -P tsconfig.json test/consolidated.contract.check.ts
 */
import 'reflect-metadata';
import { ValidationPipe, type ArgumentMetadata } from '@nestjs/common';
import { CreateGroupDto, SetGroupMembersDto, SetGroupSitesDto, UpdateCollectionPointDto } from '../src/modules/consolidated/dto/group.dto';
import { CreateScheduleDto, UpdateScheduleDto } from '../src/modules/consolidated/dto/schedule.dto';
import { CollectionListQueryDto, ReopenSubmissionsDto, UpdateCollectionDto } from '../src/modules/consolidated/dto/collection.dto';
import { CreateContributionDto, UpdateContributionDto } from '../src/modules/consolidated/dto/contribution.dto';
import { RecordReceiptDto, PublishDto, ExcludeContributionDto } from '../src/modules/consolidated/dto/receipt.dto';
import { SubmitItemCheckDto } from '../src/modules/consolidated/dto/item-check.dto';
import { ConsolidatedReportQueryDto } from '../src/modules/consolidated/dto/report.dto';
import { SetManagePermissionDto } from '../src/modules/consolidated/dto/permission.dto';

const pipe = new ValidationPipe({ whitelist: true, transform: true, forbidNonWhitelisted: true });
let failed = 0;

async function check(name: string, metatype: new () => object, value: unknown, type: 'body' | 'query' = 'body') {
  try {
    await pipe.transform(value, { type, metatype } as ArgumentMetadata);
    console.log(`  ok   ${name}`);
  } catch (e: any) {
    failed += 1;
    console.log(`  FAIL ${name}: ${JSON.stringify(e?.response?.message ?? e?.message)}`);
  }
}

(async () => {
  const declaration = { version: 'v1', accepted: true };
  await check('PATCH permissions', SetManagePermissionDto, { canManageConsolidated: true });
  await check('POST groups', CreateGroupDto, {
    name: 'Melbourne Park Precinct', description: 'Venue', hostSiteId: 1, siteIds: [1, 2],
    collectionPoint: { name: 'Loading Dock B', address: '1 Olympic Blvd', postcode: '3000', lat: -37.82, lng: 144.98, directions: 'Gate 4' },
    members: [{ userId: 7, role: 'MANAGER' }, { userId: 9, role: 'RECEIVER' }],
  });
  await check('PUT group sites (+host)', SetGroupSitesDto, { siteIds: [1, 2, 3], hostSiteId: 3 });
  await check('PUT group members', SetGroupMembersDto, { members: [{ userId: 7, role: 'MANAGER' }] });
  await check('PATCH point', UpdateCollectionPointDto, { isActive: false });
  const schedule = {
    collectionPointId: 5, method: 'SITE_DROP_OFF', recurrence: 'SELECTED_WEEKDAYS', startDate: '2026-11-13',
    endDate: '2026-12-31', daysOfWeek: [1, 5], opensDaysBefore: 0,
    submissionsCloseTime: '13:30', handoverStartTime: '13:00', handoverEndTime: '14:00',
    pickupStartTime: '14:15', pickupEndTime: '15:00',
    contactName: 'Mike', contactPhone: '0400000000', instructions: 'Use gate 4', suitabilityNotes: 'Chilled only',
    participatingSiteIds: [1, 2],
  };
  await check('POST groups/:id/schedules', CreateScheduleDto, schedule);
  await check('POST schedules (custom dates)', CreateScheduleDto, { ...schedule, recurrence: 'CUSTOM_DATES', daysOfWeek: undefined, customDates: ['2026-11-20', '2026-11-27'] });
  await check('PATCH schedules/:id', UpdateScheduleDto, { ...schedule });
  await check('PATCH collections/:id', UpdateCollectionDto, {
    collectionPointId: 5, submissionsCloseTime: '13:30', handoverStartTime: '13:00', handoverEndTime: '14:00',
    pickupStartTime: '14:15', pickupEndTime: '15:00', contactName: 'Mike', contactPhone: '0400', suitabilityNotes: 'x',
  });
  await check('POST reopen', ReopenSubmissionsDto, { until: new Date().toISOString() });
  await check('GET collections?tab', CollectionListQueryDto, { tab: 'active', groupId: '3', page: '1', limit: '20' }, 'query');
  await check('POST contributions', CreateContributionDto, {
    siteId: 1,
    foodItems: [{ name: 'Bread', category: 'Bread', totalQtyKg: 1.5, unit: 'kg', quantityDescription: '3 trays' }],
    bestBefore: new Date().toISOString(), needsRefrigeration: true, needsFreezer: false, needsAmbient: false,
    needsHot: false, needsReheating: false, allergens: ['gluten'], collectionNotes: 'Back door', photoUrls: [], declaration,
  });
  await check('PATCH contributions/:id', UpdateContributionDto, {
    foodItems: [{ name: 'Bread', totalQtyKg: 2, unit: 'kg' }], needsReheating: false, allergens: [],
  });
  await check('POST receipt (received)', RecordReceiptDto, { received: true });
  await check('POST receipt (adjust)', RecordReceiptDto, { received: true, items: [{ itemId: 4, verifiedQtyKg: 0.5 }], note: 'one tray damaged' });
  await check('POST receipt (not received)', RecordReceiptDto, { received: false, note: 'nothing arrived' });
  await check('POST exclude', ExcludeContributionDto, { reason: 'Past date' });
  await check('POST publish', PublishDto, { declaration });
  await check('POST item-check', SubmitItemCheckDto, {
    items: [{ masterFoodItemId: 10, acceptedQtyKg: 1, rejectedQtyKg: 0.5, unavailableQtyKg: 0, rejectionReason: 'QUALITY' }],
    declaration,
  });
  await check('GET reports/summary', ConsolidatedReportQueryDto, { from: '2026-10-01T00:00:00.000Z', to: '2026-11-13T00:00:00.000Z', groupId: '3' }, 'query');
  await check('GET reports/collections', ConsolidatedReportQueryDto, { from: '2026-10-01T00:00:00.000Z', to: '2026-11-13T00:00:00.000Z', pageSize: '30' }, 'query');

  console.log('\n-- the OLD app payloads, which should fail --');
  await check('(old) contribution with listingType', CreateContributionDto, { siteId: 1, listingType: 'HUMAN', isSafeForDonation: true, foodItems: [{ name: 'B', totalQtyKg: 1 }], bestBefore: new Date().toISOString(), declaration });
  await check('(old) schedule with nested times', CreateScheduleDto, { groupId: 3, collectionPointId: 5, method: 'SITE_DROP_OFF', recurrence: 'ONE_OFF', startDate: '2026-11-13', times: { submissionsClose: '13:30' }, contactName: 'a', contactPhone: 'b', suitabilityNotes: 'c' });
  await check('(old) receipt status/foodItemId', RecordReceiptDto, { status: 'RECEIVED', items: [{ foodItemId: 1, verifiedQtyKg: 1 }] });
  await check('(old) permission canManage', SetManagePermissionDto, { canManage: true });
  const expectedOldFailures = 4;
  console.log(`\n${failed === expectedOldFailures ? 'PASS' : 'FAIL'}: ${failed} failure(s), expected exactly ${expectedOldFailures} (the old payloads)`);
  process.exit(failed === expectedOldFailures ? 0 : 1);
})();
