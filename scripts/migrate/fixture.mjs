// Synthetic, LOCAL-only source fixture. Contains no actual employee data or credentials.
// Usage: node scripts/migrate/fixture.mjs --out <private directory>
import { createHash, randomBytes } from 'node:crypto';
import { mkdir, writeFile, lstat } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { EXPORT_FORMAT, VERSION } from './contract.mjs';

const headers = {
  Data_Pegawai: ['NIP','Password_Hash','Role','Status_Akun','Nama_Lengkap','Status_Kepegawaian','Pangkat_Golongan','Jabatan','No_HP','Alamat','Folder_Drive_ID','Email','Golongan_Darah','NIK','Tempat_Lahir','Tanggal_Lahir','Jenis_Kelamin','Agama','Pendidikan_Terakhir','Status_Pernikahan','TMT_Pangkat','Jenis_Jabatan','TMT_Jabatan','Unit_Organisasi','Foto_Drive_ID'],
  Master_Dokumen: ['ID_Dokumen','Nama_Dokumen','Kategori','Status_Wajib'],
  Arsip_Dokumen: ['ID_Arsip','NIP','ID_Dokumen','File_Drive_ID','File_URL','Status_Verifikasi','Catatan_Admin','Waktu_Upload','Waktu_Verifikasi','NIP_Verifier'],
  Log_Aktivitas: ['Log_ID','Timestamp','Actor_NIP','Actor_Role','Action','Target_Type','Target_ID','Description','Result'],
};
const sha = (value) => createHash('sha256').update(value).digest('hex');
const ts = '2026-10-16T00:00:00.000Z';
const master = [
  ['DOC-KTP','Kartu Tanda Penduduk (KTP)','Dokumen Pribadi','Ya'],
  ['DOC-KK','Kartu Keluarga (KK)','Dokumen Pribadi','Ya'],
  ['DOC-NPWP','NPWP','Dokumen Pribadi','Ya'],
  ['DOC-SK-CPNS','SK CPNS','Dokumen Kepegawaian','Ya'],
  ['DOC-SPMT-CPNS','SPMT CPNS','Dokumen Kepegawaian','Ya'],
  ['DOC-SK-PNS','SK PNS','Dokumen Kepegawaian','Ya'],
  ['DOC-DRH','DRH','Dokumen Kepegawaian','Ya'],
  ['DOC-IJAZAH','Ijazah Terakhir','Dokumen Pendidikan','Ya'],
  ['DOC-SKP','SKP','Dokumen Kepegawaian','Ya'],
  ['DOC-KARPEG','Kartu Pegawai (KARPEG)','Dokumen Kepegawaian','Tidak'],
  ['DOC-TASPEN','Kartu Taspen','Dokumen Kepegawaian','Tidak'],
];
export function syntheticFixture() {
  const pegawai = [
    ['199001012020011001','Admin Sintetis','Admin','PNS','Penata Muda (III/a)','5371999900000001',''],
    ['199002022021022002','Pegawai Sintetis PNS','Pegawai','PNS','Penata / III.c','5371999900000002','synthetic_photo_0001'],
    ['199003032022033003','Pegawai Sintetis PPPK','Pegawai','P3K','Ahli Pertama (IX)','5371999900000003',''],
  ].map(([nip,nama,role,status,pangkat,nik,foto]) => [
    nip,sha(nip.slice(-6)),role,'Aktif',nama,status,pangkat,'Analis Contoh','081299990001','Alamat fixture lokal','',
    `${nip}@example.test`,'O',nik,'Kupang','1990-01-01','Laki-laki','Islam','S-1 / Sarjana','Menikah',
    '2023-04-01','Fungsional','2023-04-01','Subbagian Tata Usaha',foto,
  ]);
  const files = [
    { fileId:'synthetic_doc_000001', kind:'document', name:'fixture.pdf', mimeType:'application/pdf', bytes:Buffer.from('%PDF-1.4\n% Synthetic local migration test\n%%EOF\n') },
    { fileId:'synthetic_doc_000002', kind:'document', name:'fixture.png', mimeType:'image/png', bytes:Buffer.from([0x89,0x50,0x4e,0x47,0x0d,0x0a,0x1a,0x0a,...Array(32).fill(0)]) },
    { fileId:'synthetic_photo_0001', kind:'photo', name:'photo.jpg', mimeType:'image/jpeg', bytes:Buffer.from([0xff,0xd8,0xff,0xe0,...Array(32).fill(0)]) },
  ];
  const values = {
    Data_Pegawai: pegawai,
    Master_Dokumen: master,
    Arsip_Dokumen: [
      ['archive-synthetic-1',pegawai[1][0],'DOC-KTP',files[0].fileId,'','Terverifikasi','',ts,ts,pegawai[0][0]],
      ['archive-synthetic-2',pegawai[2][0],'DOC-KK',files[1].fileId,'','Ditolak','Fixture tidak terbaca.',ts,ts,pegawai[0][0]],
    ],
    Log_Aktivitas: [
      ['synthetic-log-1',ts,pegawai[0][0],'Admin','DOKUMEN_APPROVE','Arsip_Dokumen','archive-synthetic-1','Aktivitas fixture sintetis.','SUCCESS'],
    ],
  };
  return {
    snapshot: {
      format:EXPORT_FORMAT, version:VERSION, snapshotId:'18a98a60-5672-44bf-8997-31dd31d0c765',
      createdAt:ts,finishedAt:ts,sourceTimezone:'Asia/Makassar',consistent:false,readOnlyDeclared:true,isComplete:true,
      sheets:Object.fromEntries(Object.entries(values).map(([sheet,rows]) => [sheet, {
        headers:headers[sheet],rows:rows.map((row,index) => ({rowNumber:index+2,values:row,displayValues:row.map(String)})),
      }])),
      fileManifest:files.map(({bytes,...file}) => ({...file,sizeBytes:bytes.length,sha256:sha(bytes),status:'available'})),
    }, files,
  };
}
export async function writeFixture(output) {
  const out = path.resolve(output);
  // Never replace an existing fixture directory: it might contain a real export.
  try { await lstat(out); throw new Error('OUTPUT_EXISTS'); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  await mkdir(path.join(out,'files'),{recursive:true,mode:0o700});
  const {snapshot,files} = syntheticFixture();
  await writeFile(path.join(out,'snapshot.sikap-export.json'),JSON.stringify(snapshot,null,2),{mode:0o600});
  for (const file of files) await writeFile(path.join(out,'files',`${file.fileId}.bin`),file.bytes,{mode:0o600});
  await writeFile(path.join(out,'fixture.sikap-pepper'),randomBytes(32).toString('base64'),{mode:0o600});
  await writeFile(path.join(out,'fixture.sikap-salt'),randomBytes(32).toString('base64'),{mode:0o600});
  return {employees:3,documents:2,files:files.length};
}
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const args=process.argv.slice(2);
  if(args.length!==2||args[0]!=='--out') {console.error('Usage: node scripts/migrate/fixture.mjs --out <new private directory>');process.exitCode=1;}
  else try { console.log(JSON.stringify({synthetic:true,...await writeFixture(args[1])})); }
  catch {console.error('FIXTURE_WRITE_FAILED');process.exitCode=1;}
}
