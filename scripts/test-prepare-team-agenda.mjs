import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {PGlite} from '@electric-sql/pglite';
const script=readFileSync('scripts/manual/20261102_prepare_agenda_team_access.sql','utf8');

const pg=new PGlite();await pg.waitReady;
const core=['companies','users','contacts','conversations','messages','whatsapp_channels'];
try {
 await pg.exec(`CREATE TABLE companies(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),name text);
   CREATE TABLE users(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),company_id uuid REFERENCES companies(id),name text);
   CREATE TABLE contacts(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),name text);
   CREATE TABLE conversations(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),body text);
   CREATE TABLE messages(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),body text);
   CREATE TABLE whatsapp_channels(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),company_id uuid REFERENCES companies(id),name text);
   INSERT INTO companies(name) VALUES('Empresa ficticia');
   INSERT INTO users(company_id,name) SELECT id,'Usuario ficticio' FROM companies;
   INSERT INTO whatsapp_channels(company_id,name) SELECT id,'Canal ficticio' FROM companies;
   INSERT INTO contacts(name) VALUES('Contato ficticio');
   INSERT INTO conversations(body) VALUES('Historico ficticio');
   INSERT INTO messages(body) VALUES('Mensagem ficticia');`);
 const snapshots=async()=>Promise.all(core.map(async table=>JSON.stringify((await pg.query('SELECT * FROM '+table+' ORDER BY id')).rows)));
 const before=await snapshots();
 await assert.rejects(pg.exec(script),/Banco incorreto/);await pg.exec('ROLLBACK');
 const isolated=script.replace("current_database() <> 'nexabootprincipal'","current_database() <> current_database()");
 const forcedFailure=isolated.replace('\nCOMMIT;','\nSELECT 1/0;\nCOMMIT;');
 await assert.rejects(pg.exec(forcedFailure),/division by zero/);await pg.exec('ROLLBACK');
 assert.equal((await pg.query("SELECT to_regclass('public.company_teams') AS name")).rows[0].name,null);
 assert.equal((await pg.query("SELECT to_regclass('public.clinic_appointments') AS name")).rows[0].name,null);
 assert.deepEqual(await snapshots(),before);
 await pg.exec(isolated);
 assert.deepEqual(await snapshots(),before);
 const names=(await pg.query("SELECT tablename FROM pg_tables WHERE schemaname='public'")).rows.map(r=>r.tablename);
 for (const table of ['company_operations_settings','company_teams','company_team_members','company_channel_grants','clinic_professionals','clinic_appointments']) assert(names.includes(table));
 assert(!names.includes('password_reset_tokens'));assert(!names.includes('internal_chats'));
 const companies=(await pg.query('SELECT id FROM companies')).rows;
 await pg.query('INSERT INTO company_operations_settings(company_id) VALUES($1)',[companies[0].id]);
 assert.equal((await pg.query('SELECT restrict_channels FROM company_operations_settings')).rows[0].restrict_channels,false);
 await assert.rejects(pg.exec(isolated),/ja existe/);await pg.exec('ROLLBACK');
 assert.deepEqual(await snapshots(),before);
 const policies=(await pg.query("SELECT relname,relrowsecurity FROM pg_class WHERE relname IN ('clinic_appointments','clinic_professionals')")).rows;
 assert(policies.every(r=>r.relrowsecurity));
 console.log('PASS: bloqueia outro banco; cria somente os seis recursos; preserva integralmente os registros ficticios de seis tabelas existentes; nao ativa restricoes; recusa repeticao; RLS da Agenda habilitada. Nenhum banco externo usado.');
 
} finally {await pg.close();}
