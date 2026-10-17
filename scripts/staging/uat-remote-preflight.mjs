#!/usr/bin/env node
// Read-only inspection of ONE pinned UAT database. Never imports, seeds, deletes,
// changes schema, reads application rows/credentials, or accepts caller SQL/targets.
// A schema fingerprint is measured, not compared with an independently migrated
// expected schema. This MVP cannot authorize import, even on an empty database.
import { readFile, readdir, lstat } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { UAT_ACCOUNT, UAT_DB } from './deploy-holding.mjs';
import { childEnvFor, createIsolatedDir, defaultTmpRoot, PREFLIGHT_PREFIX, WRANGLER_BIN } from './deploy-uat-app.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
export const CONFIG_SHA = '54cb2348a8619f191418f897c26354577ee532699d4e6bf938bddcaf5d1a2de3';
export const APP_TABLES = Object.freeze(['pegawai','akun','sesi','rate_limit','arsip_dokumen',
  'arsip_dokumen_versi','arsip_dokumen_riwayat','pengajuan_perubahan','log_aktivitas',
  'notifikasi_outbox','backup_job','backup_part','r2_purge_queue']);
export const REF_COUNTS = Object.freeze({ ref_pangkat_golongan:34, ref_unit_organisasi:3,
  ref_pendidikan:8, jenis_dokumen:11, jenis_dokumen_wajib:22 });
// No row text, hash, phone, NIP, provider value, cookie or identity is selected.
export const INSPECT_SQL = [
  "SELECT type,name,tbl_name,sql FROM sqlite_schema WHERE sql IS NOT NULL AND substr(name,1,7)<>'sqlite_' AND substr(name,1,4)<>'_cf_' AND name<>'d1_migrations' ORDER BY type,name",
  'SELECT name FROM d1_migrations ORDER BY name',
  `SELECT ${APP_TABLES.map(t=>`(SELECT COUNT(*) FROM ${t}) AS ${t}`).join(',')}`,
  `SELECT ${Object.keys(REF_COUNTS).map(t=>`(SELECT COUNT(*) FROM ${t}) AS ${t}`).join(',')}`,
].join(';\n')+';';
const fail = code => { const error=new Error(code);error.code=code;throw error; };
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
function integer(value) { return Number.isSafeInteger(value)&&value>=0; }

export function analyseResults(raw, migrationNames) {
  if (!Array.isArray(raw)||raw.length!==4||raw.some(x=>!x||x.success!==true||!Array.isArray(x.results))) fail('UAT_RESPONSE_INVALID');
  const [ddl,migrations,app,refs]=raw.map(x=>x.results);
  if(ddl.length>256||migrations.length>1000||app.length!==1||refs.length!==1) fail('UAT_RESPONSE_INVALID');
  const schema=ddl.map(r=>{
    if(!r||!['table','index','trigger','view'].includes(r.type)||!['name','tbl_name','sql'].every(k=>typeof r[k]==='string')||r.sql.length>65536||r.name.length>200||r.tbl_name.length>200)fail('UAT_RESPONSE_INVALID');
    // Reject unexpected response fields; raw DDL stays in memory, never in the report.
    if(Object.keys(r).some(k=>!['type','name','tbl_name','sql'].includes(k)))fail('UAT_RESPONSE_INVALID');
    return {type:r.type,name:r.name,tbl_name:r.tbl_name,sql:r.sql.replaceAll('\r\n','\n').trim()};
  }).sort((a,b)=>a.type.localeCompare(b.type)||a.name.localeCompare(b.name));
  if(Buffer.byteLength(JSON.stringify(schema))>262144)fail('UAT_RESPONSE_INVALID');
  const names=migrations.map(r=>{
    if(Object.keys(r).length!==1||typeof r.name!=='string'||!/^\d{4}_[a-z0-9_]+\.sql$/.test(r.name))fail('UAT_RESPONSE_INVALID');return r.name;
  }).sort();
  if(new Set(names).size!==names.length)fail('UAT_RESPONSE_INVALID');
  const counts={}, referenceCounts={};
  if(Object.keys(app[0]).length!==APP_TABLES.length||Object.keys(refs[0]).length!==Object.keys(REF_COUNTS).length)fail('UAT_RESPONSE_INVALID');
  for(const t of APP_TABLES){if(!integer(app[0][t]))fail('UAT_RESPONSE_INVALID');counts[t]=app[0][t];}
  for(const t of Object.keys(REF_COUNTS)){if(!integer(refs[0][t]))fail('UAT_RESPONSE_INVALID');referenceCounts[t]=refs[0][t];}
  const codes=[];
  const tableNames=new Set(schema.filter(s=>s.type==='table').map(s=>s.name));
  const knownTables=new Set([...APP_TABLES,...Object.keys(REF_COUNTS),'pengaturan']);
  if([...knownTables].some(t=>!tableNames.has(t)))codes.push('SCHEMA_TABLE_MISSING');
  if([...tableNames].some(t=>!knownTables.has(t)))codes.push('UNEXPECTED_APPLICATION_TABLE');
  if(schema.some(s=>s.name.startsWith('__sikap_uat_tx_probe')))codes.push('PROBE_RESIDUE');
  const migrationsMatch=JSON.stringify(names)===JSON.stringify([...migrationNames].sort());
  if(!migrationsMatch)codes.push('MIGRATIONS_MISMATCH');
  const referenceCountsMatch=Object.entries(REF_COUNTS).every(([k,v])=>referenceCounts[k]===v);
  if(!referenceCountsMatch)codes.push('REFERENCE_COUNTS_DIFFER');
  const targetEmpty=Object.values(counts).every(n=>n===0);
  const structuralIssues=codes.length;
  if(!targetEmpty)codes.push('TARGET_NOT_EMPTY');
  return {ok:structuralIssues===0,preflightPassed:false,readOnly:true,target:'sikap-uat-db',
    databaseId:UAT_DB,counts,referenceCounts,migrationsMatch,referenceCountsMatch,targetEmpty,
    schemaFingerprint:hash(JSON.stringify(schema)),schemaCompared:false,
    accessVerified:false,pepperVerified:false,credentialScopeVerified:false,transactionAtomicityVerified:false,
    readyForImport:false,codes,
    outstandingRequirements:['EXPECTED_SCHEMA_COMPARISON','TARGET_REFERENCE_CONTENT_VALIDATION',
      'REMOTE_BATCH_ATOMICITY_PROOF','TARGET_PEPPER_PROOF','ACCESS_AND_BINDINGS_EVIDENCE','EXPLICIT_EMPTY_IMPORT_TARGET'],
    exitCode:structuralIssues===0&&targetEmpty?0:2};
}

export function parseArgs(argv){
  if(argv.length!==1||argv[0]!=='--inspect-uat')fail('CLI_ARGUMENTS');
}
// Wrangler 4 merges .env/.env.local from its cwd into process.env, which could re-introduce keys
// childEnvFor strips (API base URL, proxies, CLOUDFLARE_ENV, token). It therefore runs from a fresh,
// verified-empty mkdtemp dir outside the repo (no ancestor wrangler config/redirect), removed in finally.
export async function inspectUat({env=process.env,spawn=spawnSync,base=ROOT,tmpRoot=defaultTmpRoot()}={}){
  if(env.CLOUDFLARE_ACCOUNT_ID!==UAT_ACCOUNT)fail('UAT_ACCOUNT_REQUIRED');
  const config=path.resolve(base,'ops/uat-app/wrangler.toml');
  const stat=await lstat(config);if(!stat.isFile()||stat.isSymbolicLink())fail('UAT_CONFIG_UNSAFE');
  const cfg=(await readFile(config,'utf8')).replaceAll('\r\n','\n');
  if(hash(cfg)!==CONFIG_SHA||!cfg.includes(UAT_DB))fail('UAT_CONFIG_MISMATCH');
  const migrations=(await readdir(path.join(ROOT,'migrations'))).filter(n=>/^\d{4}_[a-z0-9_]+\.sql$/.test(n)).sort();
  let isolated;
  try{isolated=await createIsolatedDir({prefix:PREFLIGHT_PREFIX,tmpRoot,bases:[base]});}
  catch(e){fail(/^UAT_[A-Z_]+$/.test(e?.message)?e.message:'UAT_ISOLATION_FAILED');}
  let r;
  try{
    r=spawn(process.execPath,[WRANGLER_BIN,'d1','execute','DB',
      '--remote','--config',config,'--command',INSPECT_SQL,'--json'],{
      cwd:isolated.path,env:childEnvFor(env),shell:false,encoding:'utf8',timeout:60000,maxBuffer:2097152,
    });
  }finally{await isolated.cleanup();}
  if(r.error||r.status!==0)fail('UAT_READ_FAILED');
  let parsed;try{parsed=JSON.parse(r.stdout);}catch{fail('UAT_RESPONSE_INVALID');}
  return analyseResults(parsed,migrations);
}
export async function main(argv=process.argv.slice(2),deps={}){
  try{parseArgs(argv);const report=await inspectUat(deps);console.log(JSON.stringify(report));return report.exitCode;}
  catch(e){const code=/^(UAT_[A-Z_]+|CLI_ARGUMENTS)$/.test(e?.code)?e.code:'UAT_INSPECTION_FAILED';console.error(JSON.stringify({ok:false,readOnly:true,readyForImport:false,codes:[code]}));return 1;}
}
if(process.argv[1]&&import.meta.url===pathToFileURL(path.resolve(process.argv[1])).href)process.exitCode=await main();
