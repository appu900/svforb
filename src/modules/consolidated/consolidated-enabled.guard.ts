import { CanActivate, Injectable, NotFoundException } from '@nestjs/common';
import { consolidatedEnabled } from './consolidated.constants';

/**
 * Hides the whole feature until it is switched on.
 *
 * 404 rather than 403: a disabled feature should look like it does not exist,
 * not like something the caller is being kept out of.
 */
@Injectable()
export class ConsolidatedEnabledGuard implements CanActivate {
  canActivate(): boolean {
    if (!consolidatedEnabled()) {
      throw new NotFoundException('Cannot GET this resource');
    }
    return true;
  }
}
