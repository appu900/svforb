process.env.NODE_TLS_REJECT_UNAUTHORIZED='0';
import 'dotenv/config';
import { PrismaClient } from '@prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';
import { Pool } from 'pg';
import * as fs from 'fs'; import * as path from 'path';
const pool=new Pool({connectionString:process.env.DATABASE_URL,ssl:{rejectUnauthorized:false,ca:fs.readFileSync(path.join(process.cwd(),'src/infra/prisma','ca.pem')).toString()}});
const p=new PrismaClient({adapter:new PrismaPg(pool)});
p.orgSubscription.findMany({select:{organisationId:true,status:true,trialEndsAt:true,stripeSubscriptionId:true}})
 .then(r=>console.table(r)).finally(async()=>{await p.$disconnect();await pool.end();});
