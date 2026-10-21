import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile, mkdir, mkdtemp, writeFile, rm } from 'node:fs/promises';
import { existsSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { analyseResults, inspectUat, main, parseArgs, INSPECT_SQL, APP_TABLES, REF_COUNTS, CONFIG_SHA } from './uat-remote-preflight.mjs';
import { UAT_ACCOUNT, UAT_DB } from './deploy-holding.mjs';
import { defaultTmpRoot, PREFLIGHT_PREFIX, WRANGLER_BIN } from './deploy-uat-app.mjs';
const repoRoot=path.resolve(import.meta.dirname,'../..');
// This preflight is RETIRED: it stays pinned to the historical OLD fixture app config (old UAT DB)
// and fails closed against the rebound ops/uat-app/wrangler.toml. The literal below is that
// historical config, used only to keep isolation/spawn-argument coverage in temp fixtures.
const RETIRED_CONFIG=['# Isolated UAT FULL APP. Never use the root config or production resources.','name = "sikap-uat"',
  'compatibility_date = "2026-10-17"','compatibility_flags = ["nodejs_compat"]','pages_build_output_dir = "../../dist-uat-app"','',
  '[vars]','APP_URL = "https://sikap-uat.pages.dev"','SESSION_TTL_HOURS = "12"','ACCESS_REQUIRED = "1"',
  'ACCESS_TEAM_DOMAIN = "shy-thunder-ffc9.cloudflareaccess.com"','ACCESS_AUDIENCE = "50b2c68c92474c0232581b9641f9107836ca66939e439e2314f37384f4f2b3e9"','',
  '[[d1_databases]]','binding = "DB"','database_name = "sikap-uat-db"',`database_id = "${UAT_DB}"`,'migrations_dir = "../../migrations"','',
  '[[r2_buckets]]','binding = "FILES"','bucket_name = "sikap-uat-files"','','[[r2_buckets]]','binding = "BACKUPS"','bucket_name = "sikap-uat-backup"',''].join('\n');
async function retiredBase(t){const d=await mkdtemp(path.join(tmpdir(),'sikap-preflight-retired-'));t.after(()=>rm(d,{recursive:true,force:true}));
  await mkdir(path.join(d,'ops/uat-app'),{recursive:true});await writeFile(path.join(d,'ops/uat-app/wrangler.toml'),RETIRED_CONFIG);return d;}
test('retired preflight stays pinned to the old fixture config and refuses the rebound app config before any spawn',async(t)=>{
  assert.equal(createHash('sha256').update(RETIRED_CONFIG).digest('hex'),CONFIG_SHA);
  const current=(await readFile(path.join(repoRoot,'ops/uat-app/wrangler.toml'),'utf8')).replaceAll('\r\n','\n');
  assert.notEqual(createHash('sha256').update(current).digest('hex'),CONFIG_SHA);
  assert.ok(!current.includes(UAT_DB));
  const tmpRoot=await scratch(t,'sikap-preflight-retired-root-');
  const dir=await mkdtemp(path.join(tmpdir(),'sikap-preflight-current-'));t.after(()=>rm(dir,{recursive:true,force:true}));
  await mkdir(path.join(dir,'ops/uat-app'),{recursive:true});await writeFile(path.join(dir,'ops/uat-app/wrangler.toml'),current);
  for(const base of [dir,repoRoot])
    await assert.rejects(inspectUat({base,env:{CLOUDFLARE_ACCOUNT_ID:UAT_ACCOUNT},tmpRoot,spawn(){assert.fail('no spawn');}}),{code:'UAT_CONFIG_MISMATCH'});
  assert.deepEqual(readdirSync(tmpRoot),[]);
});
const isInside=(parent,child)=>{const r=path.relative(parent,child);return r===''||(!r.startsWith('..')&&!path.isAbsolute(r));};
const HOSTILE={CLOUDFLARE_API_BASE_URL:'https://evil.test/client/v4',HTTPS_PROXY:'http://proxy.invalid',HTTP_PROXY:'http://proxy.invalid',
  https_proxy:'http://proxy.invalid',WRANGLER_LOG:'debug',CLOUDFLARE_ENV:'production',NODE_OPTIONS:'--require=evil.js',
  WRANGLER_CONFIG:path.join(repoRoot,'wrangler.toml'),CLOUDFLARE_INCLUDE_PROCESS_ENV:'true'};
async function scratch(t,name){const d=await mkdtemp(path.join(defaultTmpRoot(),name));t.after(()=>rm(d,{recursive:true,force:true}));return d;}
const migrations=['0001_init.sql'];
function response(nonempty=true){return[
  {success:true,results:[...APP_TABLES,...Object.keys(REF_COUNTS),'pengaturan'].map(n=>({type:'table',name:n,tbl_name:n,sql:`CREATE TABLE ${n}(id INTEGER)`}))},
  {success:true,results:migrations.map(name=>({name}))},
  {success:true,results:[Object.fromEntries(APP_TABLES.map(t=>[t,nonempty&&['pegawai','akun'].includes(t)?3:0]))]},
  {success:true,results:[{...REF_COUNTS}]},
];}
test('nonempty fixture target is explicitly refused without claiming readiness',()=>{
  const r=analyseResults(response(),migrations);
  assert.deepEqual(r.codes,['TARGET_NOT_EMPTY']);assert.equal(r.exitCode,2);
  for(const key of ['preflightPassed','schemaCompared','readyForImport','accessVerified','transactionAtomicityVerified','pepperVerified'])assert.equal(r[key],false);
  assert.equal(r.counts.pegawai,3);assert.equal(r.readOnly,true);
});
test('even empty matching counts never prove schema contents or authorize import',()=>{
  const r=analyseResults(response(false),migrations);assert.equal(r.targetEmpty,true);assert.equal(r.exitCode,0);
  assert.equal(r.readyForImport,false);assert.equal(r.preflightPassed,false);assert.equal(r.schemaCompared,false);
  assert.equal(r.schemaFingerprint.length,64);
});
test('missing migration, unknown table, changed reference counts are surfaced safely',()=>{
  const v=response();v[0].results.push({type:'table',name:'unexpected',tbl_name:'unexpected',sql:'CREATE TABLE unexpected(x TEXT)'});v[3].results[0].ref_unit_organisasi=2;
  const r=analyseResults(v,[]);assert.ok(r.codes.includes('MIGRATIONS_MISMATCH'));assert.ok(r.codes.includes('UNEXPECTED_APPLICATION_TABLE'));assert.ok(r.codes.includes('REFERENCE_COUNTS_DIFFER'));assert.equal(r.ok,false);
  assert.ok(!JSON.stringify(r).includes('CREATE TABLE'));
});
test('untrusted response extra columns, invalid counts and large schema fail closed',()=>{
  for(const mutate of [(v)=>{v[2].results[0].pegawai=-1;},(v)=>{v[0].results[0].password='neverprint';},(v)=>{v[1].results[0].name='../x';},(v)=>{v[0].results[0].sql='x'.repeat(65537);}]){
    const v=response();mutate(v);assert.throws(()=>analyseResults(v,migrations),{code:'UAT_RESPONSE_INVALID'});
  }
});
test('CLI accepts one explicit inspection action, never caller target/SQL/remote options',()=>{
  parseArgs(['--inspect-uat']);for(const args of [[],['--remote'],['--inspect-uat','--sql','DROP'],['--inspect-uat','--database','production']])assert.throws(()=>parseArgs(args),{code:'CLI_ARGUMENTS'});
  assert.ok(!/\b(INSERT|UPDATE|DELETE|CREATE|DROP|ALTER|REPLACE)\b/.test(INSPECT_SQL));
  assert.ok(!/\b(password_hash|actor_nip|no_hp|nik)\b/i.test(INSPECT_SQL));
});
test('pinned target, account, config and SELECT-only spawn arguments cannot be overridden',async(t)=>{
  const dir=await retiredBase(t);
  const tmpRoot=await scratch(t,'sikap-preflight-root-');
  for(const env of [{},{CLOUDFLARE_ACCOUNT_ID:'0'.repeat(32)}])
    await assert.rejects(inspectUat({base:dir,env,tmpRoot,spawn(){assert.fail();}}),{code:'UAT_ACCOUNT_REQUIRED'});
  let calls=0;let seen;
  const env={...HOSTILE,CLOUDFLARE_ACCOUNT_ID:UAT_ACCOUNT,PATH:'test-path',CLOUDFLARE_API_TOKEN:'tok'};
  const report=await inspectUat({base:dir,env,tmpRoot,spawn(bin,args,opts){
    calls++;assert.equal(bin,process.execPath);
    assert.deepEqual(args,[WRANGLER_BIN,'d1','execute','DB','--remote','--config',path.resolve(dir,'ops/uat-app/wrangler.toml'),'--command',INSPECT_SQL,'--json']);
    assert.ok(path.isAbsolute(args[6]));
    assert.equal(opts.shell,false);assert.equal(opts.encoding,'utf8');
    assert.deepEqual(Object.keys(opts.env).sort(),['CLOUDFLARE_ACCOUNT_ID','CLOUDFLARE_API_TOKEN','PATH']);
    assert.equal(opts.env.CLOUDFLARE_ACCOUNT_ID,UAT_ACCOUNT);
    for(const k of Object.keys(HOSTILE))assert.equal(opts.env[k],undefined,k);
    // Fresh empty cwd outside the repo and outside the fixture base: no .env/.env.local/wrangler config to load.
    assert.ok(!isInside(repoRoot,opts.cwd)&&!isInside(dir,opts.cwd)&&isInside(tmpRoot,opts.cwd));
    assert.ok(path.basename(opts.cwd).startsWith(PREFLIGHT_PREFIX));
    assert.deepEqual(readdirSync(opts.cwd),[]);
    seen=opts.cwd;
    const v=response();v[1].results=[];return{status:0,stdout:JSON.stringify(v)};
  }});
  assert.equal(calls,1);assert.ok(!existsSync(seen));assert.deepEqual(readdirSync(tmpRoot),[]);
  assert.ok(report.codes.includes('MIGRATIONS_MISMATCH'));assert.ok(report.codes.includes('TARGET_NOT_EMPTY'));
  assert.equal(report.migrationsMatch,false);assert.equal(report.ok,false);assert.equal(report.exitCode,2);
  assert.equal(report.readyForImport,false);assert.equal(report.preflightPassed,false);assert.equal(report.readOnly,true);
  // Failed and throwing spawns also remove the isolated cwd.
  let failed;
  await assert.rejects(inspectUat({base:dir,env,tmpRoot,spawn(_b,_a,opts){failed=opts.cwd;return{status:1,stdout:'',stderr:'x'};}}),{code:'UAT_READ_FAILED'});
  assert.ok(failed&&!existsSync(failed));assert.deepEqual(readdirSync(tmpRoot),[]);
  await assert.rejects(inspectUat({base:dir,env,tmpRoot,spawn(_b,_a,opts){failed=opts.cwd;throw Error('boom');}}),/boom/);
  assert.ok(!existsSync(failed));assert.deepEqual(readdirSync(tmpRoot),[]);
  // Isolation refused (tmp root inside the repo) before any spawn; nothing created there.
  const before=readdirSync(path.join(repoRoot,'scripts'));
  await assert.rejects(inspectUat({base:dir,env,tmpRoot:path.join(repoRoot,'scripts'),spawn(){assert.fail();}}),{code:'UAT_RELEASE_INSIDE_REPO'});
  assert.deepEqual(readdirSync(path.join(repoRoot,'scripts')),before);
  // Digest check runs before isolation and spawn.
  await writeFile(path.join(dir,'ops/uat-app/wrangler.toml'),'name="production"');
  await assert.rejects(inspectUat({base:dir,env:{CLOUDFLARE_ACCOUNT_ID:UAT_ACCOUNT},tmpRoot,spawn(){assert.fail();}}),{code:'UAT_CONFIG_MISMATCH'});
  assert.deepEqual(readdirSync(tmpRoot),[]);
});
test('CLI report shape on success and refusal is unchanged',async(t)=>{
  const tmpRoot=await scratch(t,'sikap-preflight-cli-');
  const base=await retiredBase(t);
  const out=[];const err=[];t.mock.method(console,'log',(s)=>out.push(s));t.mock.method(console,'error',(s)=>err.push(s));
  const code=await main(['--inspect-uat'],{base,env:{CLOUDFLARE_ACCOUNT_ID:UAT_ACCOUNT},tmpRoot,spawn:()=>({status:0,stdout:JSON.stringify(response())})});
  assert.equal(code,2);const r=JSON.parse(out[0]);assert.equal(r.readyForImport,false);assert.ok(r.codes.includes('TARGET_NOT_EMPTY'));
  assert.equal(await main(['--inspect-uat'],{env:{},tmpRoot,spawn(){assert.fail();}}),1);
  assert.deepEqual(JSON.parse(err[0]),{ok:false,readOnly:true,readyForImport:false,codes:['UAT_ACCOUNT_REQUIRED']});
  // Default (real repo) config is the rebound app: the retired preflight refuses it without spawning.
  assert.equal(await main(['--inspect-uat'],{env:{CLOUDFLARE_ACCOUNT_ID:UAT_ACCOUNT},tmpRoot,spawn(){assert.fail();}}),1);
  assert.deepEqual(JSON.parse(err[1]),{ok:false,readOnly:true,readyForImport:false,codes:['UAT_CONFIG_MISMATCH']});
  assert.deepEqual(readdirSync(tmpRoot),[]);
});
test('remote failures never return provider output or invoke a retry/write',async(t)=>{
  const base=await retiredBase(t);
  let calls=0;await assert.rejects(inspectUat({base,env:{CLOUDFLARE_ACCOUNT_ID:UAT_ACCOUNT},spawn(){calls++;return{status:1,stdout:'private provider detail',stderr:'secret'};}}),{code:'UAT_READ_FAILED'});assert.equal(calls,1);
});
