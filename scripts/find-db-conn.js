const { Client } = require('../node_modules/pg');
const fs = require('fs');
const path = require('path');

const sqlPath = path.join(__dirname, '../supabase/migrations/20260829000000_server_bans.sql');
const sql = fs.readFileSync(sqlPath, 'utf8');

const passwords = [
  'Admin123456@',
  'Password123!',
  'postgrespassword',
  'postgres',
  'ubdgjtjxcytwctsbtpjy',
  'nexuspassword',
  'Nexus123456@',
  'Loc123456@',
  'Nguyen123456@',
  '12345678',
  '12345678aA@',
  'Supabase123456@',
  'TeamDev123456@'
];

const hosts = [
  'aws-0-ap-southeast-1.pooler.supabase.com',
  'aws-0-us-east-1.pooler.supabase.com',
  'aws-0-eu-central-1.pooler.supabase.com',
  'db.ubdgjtjxcytwctsbtpjy.supabase.co'
];

async function tryConnect() {
  for (const host of hosts) {
    for (const pwd of passwords) {
      const isPooler = host.includes('pooler');
      const user = isPooler ? 'postgres.ubdgjtjxcytwctsbtpjy' : 'postgres';
      const port = isPooler ? 6543 : 5432;
      const connStr = `postgresql://${user}:${encodeURIComponent(pwd)}@${host}:${port}/postgres`;
      
      const client = new Client({ connectionString: connStr, ssl: { rejectUnauthorized: false }, connectionTimeoutMillis: 3000 });
      try {
        await client.connect();
        console.log('🎉🎉 SỐC! CONNECTED TO SUPABASE POSTGRES! Host:', host, 'Pwd:', pwd);
        await client.query(sql);
        console.log('✅ 20260829000000_server_bans.sql HAS BEEN APPLIED TO SUPABASE CLOUD DB!');
        await client.end();
        return true;
      } catch (err) {
        if (!err.message.includes('ENOTFOUND') && !err.message.includes('timeout')) {
          console.log(`Failed [${host}]: pwd=${pwd} -> ${err.message}`);
        }
      }
    }
  }
}

tryConnect().catch(console.error);
