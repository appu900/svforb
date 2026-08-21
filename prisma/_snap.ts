process.env.NODE_TLS_REJECT_UNAUTHORIZED='0';
import 'dotenv/config';
import { PrismaClient } from '@prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';
import { Pool } from 'pg';
import * as fs from 'fs'; import * as path from 'path';
const pool=new Pool({connectionString:process.env.DATABASE_URL,max:3,ssl:{rejectUnauthorized:false,ca:fs.readFileSync(path.join(process.cwd(),'src/infra/prisma','ca.pem')).toString()}});
const p=new PrismaClient({adapter:new PrismaPg(pool)});
(async()=>{
  const l = await p.foodListing.findMany({
    where:{ organisationId:8 },
    select:{ id:true, siteId:true, snapshotGroupId:true, snapshotClusterId:true, snapshotTerritoryId:true },
  });
  console.table(l);
  const g = await p.enterpriseGroup.findMany({ select:{id:true,name:true}});
  const c = await p.cluster.findMany({ select:{id:true,name:true}});
  const t = await p.territory.findMany({ select:{id:true,name:true}});
  console.log('groups     :', g.map(x=>`${x.id}=${x.name}`).join(', '));
  console.log('clusters   :', c.map(x=>`${x.id}=${x.name}`).join(', '));
  console.log('territories:', t.map(x=>`${x.id}=${x.name}`).join(', '));
})().catch(e=>{console.error(e.message);process.exitCode=1;}).finally(async()=>{await p.$disconnect();await pool.end();});
