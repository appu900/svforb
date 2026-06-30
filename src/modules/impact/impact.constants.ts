import { OrgType } from '@prisma/client';

// CO2 saved per kg of food rescued from landfill/incineration
export const CO2_PER_KG = 2.1;

// Average weight of one meal — used to convert kg of human-bound food into meal count
export const MEAL_WEIGHT_KG = 0.42;

// Estimated market value per kg of rescued food — adjust as real pricing data becomes available
export const FOOD_VALUE_PER_KG_USD = 2.5;

// Orgs that receive food on behalf of people
export const CHARITY_ORG_TYPES: OrgType[] = [
  OrgType.CHARITY,
  OrgType.CHARITY_SINGLE,
  OrgType.CHARITY_MULTI,
];

// Orgs that receive food on behalf of animals
export const ANIMAL_ORG_TYPES: OrgType[] = [OrgType.FARMER_CONSUMER];

// Any org type that claims food (as opposed to listing it)
export const RECEIVER_ORG_TYPES: OrgType[] = [...CHARITY_ORG_TYPES, ...ANIMAL_ORG_TYPES];

export type ImpactPeriod = 'week' | 'month' | 'year' | 'lifetime';
export type ImpactMode = 'DONOR' | 'RECEIVER';
