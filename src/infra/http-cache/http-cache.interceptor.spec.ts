import {
  CanActivate,
  Controller,
  ExecutionContext,
  Get,
  Global,
  INestApplication,
  Injectable,
  Module,
  Post,
  UseGuards,
} from '@nestjs/common';
import { Test } from '@nestjs/testing';
import * as request from 'supertest';
import { RedisService } from '../redis/redis.service';
import { InvalidatesCache, NoCache } from './http-cache.decorators';
import { domainForPath } from './http-cache.domains';
import { HttpCacheModule } from './http-cache.module';

/** Just enough of RedisService for the cache, held in memory. */
class FakeRedis {
  store = new Map<string, string>();
  down = false;
  private guard() {
    if (this.down) throw new Error('connection refused');
  }
  async get(key: string) {
    this.guard();
    return this.store.get(key) ?? null;
  }
  async set(key: string, value: string) {
    this.guard();
    this.store.set(key, value);
  }
  getClient() {
    return {
      incr: async (key: string) => {
        this.guard();
        const next = Number(this.store.get(key) ?? 0) + 1;
        this.store.set(key, String(next));
        return next;
      },
    };
  }
}

/** Stands in for JwtAuthGuard: the user id comes from a header. */
@Injectable()
class FakeAuthGuard implements CanActivate {
  canActivate(context: ExecutionContext) {
    const req = context.switchToHttp().getRequest();
    const id = req.headers['x-user'];
    if (id) req.user = { sub: Number(id), orgId: 1 };
    return true;
  }
}

let calls = 0;

@Controller('sites')
@UseGuards(FakeAuthGuard)
class SitesTestController {
  @Get()
  list() {
    calls++;
    return { calls };
  }
  @Get('live')
  @NoCache()
  live() {
    calls++;
    return { calls };
  }
  @Post()
  create() {
    return { ok: true };
  }
}

@Controller('drivers')
class DriversTestController {
  @Post('live')
  @InvalidatesCache()
  ping() {
    return { ok: true };
  }
  @Post('pickups')
  pickup() {
    return { ok: true };
  }
}

@Controller('billing')
class BillingTestController {
  @Get('payments')
  payments() {
    calls++;
    return { calls };
  }
}

describe('HttpCacheInterceptor', () => {
  let app: INestApplication;
  let redis: FakeRedis;

  beforeEach(async () => {
    calls = 0;
    redis = new FakeRedis();
    // Mirrors the real RedisModule, which is global.
    @Global()
    @Module({
      providers: [{ provide: RedisService, useValue: redis }],
      exports: [RedisService],
    })
    class FakeRedisModule {}

    const moduleRef = await Test.createTestingModule({
      imports: [FakeRedisModule, HttpCacheModule],
      controllers: [SitesTestController, DriversTestController, BillingTestController],
    }).compile();
    app = moduleRef.createNestApplication();
    app.setGlobalPrefix('/api/v1');
    await app.init();
  });

  afterEach(() => app.close());

  const get = (path: string, user?: string) => {
    const req = request(app.getHttpServer()).get(`/api/v1/${path}`);
    return user ? req.set('x-user', user) : req;
  };
  const post = (path: string) => request(app.getHttpServer()).post(`/api/v1/${path}`);

  it('serves a repeat GET from the cache', async () => {
    const first = await get('sites', '7');
    const second = await get('sites', '7');
    expect(first.headers['x-cache']).toBe('MISS');
    expect(second.headers['x-cache']).toBe('HIT');
    expect(second.body).toEqual({ calls: 1 });
  });

  it('treats reordered query params as the same request', async () => {
    await get('sites?a=1&b=2', '7');
    const second = await get('sites?b=2&a=1', '7');
    expect(second.headers['x-cache']).toBe('HIT');
  });

  it('never serves one user another user’s response', async () => {
    await get('sites', '7');
    const other = await get('sites', '8');
    expect(other.headers['x-cache']).toBe('MISS');
    expect(other.body).toEqual({ calls: 2 });
  });

  it('rebuilds after a write in the same domain', async () => {
    await get('sites', '7');
    await post('sites').expect(201);
    const after = await get('sites', '7');
    expect(after.headers['x-cache']).toBe('MISS');
    expect(after.body).toEqual({ calls: 2 });
    expect((await get('sites', '7')).headers['x-cache']).toBe('HIT');
  });

  it('leaves unrelated domains cached', async () => {
    await get('billing/payments');
    await post('drivers/pickups');
    expect((await get('billing/payments')).headers['x-cache']).toBe('HIT');
  });

  it('skips invalidation for @InvalidatesCache() with no domains', async () => {
    await get('sites', '7');
    await post('drivers/live');
    await post('drivers/pickups'); // activity only — sites are structure
    expect((await get('sites', '7')).headers['x-cache']).toBe('HIT');
  });

  it('does not cache @NoCache routes', async () => {
    await get('sites/live', '7');
    const second = await get('sites/live', '7');
    expect(second.headers['x-cache']).toBeUndefined();
    expect(second.body).toEqual({ calls: 2 });
  });

  it('falls through to the handler when Redis is down', async () => {
    redis.down = true;
    const res = await get('sites', '7').expect(200);
    expect(res.body).toEqual({ calls: 1 });
    await post('sites').expect(201);
  });
});

describe('domainForPath', () => {
  it('prefers the longest matching prefix', () => {
    expect(domainForPath('/api/v1/enterprise/reports/dashboard')).toBe('activity');
    expect(domainForPath('/api/v1/enterprise/groups')).toBe('structure');
    expect(domainForPath('/api/v1/enterprise/invoices')).toBe('billing');
  });

  it('does not match a prefix mid-segment', () => {
    expect(domainForPath('/api/v1/sitesfoo')).toBeNull();
  });

  it('leaves unmapped routes uncached', () => {
    expect(domainForPath('/api/v1/health')).toBeNull();
    expect(domainForPath('/api/v1')).toBeNull();
  });
});
