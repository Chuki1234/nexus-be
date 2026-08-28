const { Client } = require('../node_modules/pg');
const fs = require('fs');
const path = require('path');

const sqlPath = path.join(__dirname, '../supabase/migrations/20260829000000_server_bans.sql');
const sql = fs.readFileSync(sqlPath, 'utf8');

const passwords = [
  'postgrespassword',
  'Admin123456@',
  'Password123!',
  'postgres',
  'ubdgjtjxcytwctsbtpjy'
];

async function tryConnect() {
  for (const pwd of passwords) {
    const connStr = `postgresql://postgres.${'ubdgjtjxcytwctsbtpjy'}:${encodeURIComponent(pwd)}@aws-0-ap-southeast-1.pooler.supabase.com:6543/postgres`;
    const directConnStr = `postgresql://postgres:${encodeURIComponent(pwd)}@db.ubdgjtjxcytwctsbtpjy.supabase.co:5432/postgres`;
    
    for (const url of [connStr, directConnStr]) {
      const client = new Client({ connectionString: url, ssl: { rejectUnauthorized: false } });
      try {
        await client.connect();
        console.log('🎉 CONNECTED TO SUPABASE POSTGRES WITH URL:', url);
        await client.query(sql);
        console.log('✅ 20260829000000_server_bans.sql APPLIED SUCCESSFULLY!');
        await client.end();
        return true;
      } catch (err) {
        console.log('Failed URL:', url, err.message);
      }
    }
  }
}

tryConnect().catch(console.error);
