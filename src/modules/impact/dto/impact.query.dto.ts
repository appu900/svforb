import { IsIn, IsOptional } from 'class-validator';
import { ImpactPeriod } from '../impact.constants';

export class ImpactQueryDto {
  @IsOptional()
  @IsIn(['week', 'month', 'year', 'lifetime'])
  period?: ImpactPeriod = 'week';
}
