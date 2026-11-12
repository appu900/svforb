import { IsBoolean } from 'class-validator';

/** Grant or withdraw the right to manage collections (SPEC R1). */
export class SetManagePermissionDto {
  @IsBoolean() canManageConsolidated!: boolean;
}
