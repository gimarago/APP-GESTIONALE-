import {open,readdir,lstat} from 'node:fs/promises';
import {resolve,join,basename,extname} from 'node:path';
import {xmlEngine} from '../xml/engine.js';
export async function readLimited(path) {
  if((await lstat(path)).isSymbolicLink()) throw Error('SYMLINK_NOT_ALLOWED');
  const file=await open(path,'r');
  try {
    const stat=await file.stat();if(!stat.isFile() || stat.size>2000000) throw Error('EXPORT_SIZE_LIMIT');
    const bytes=Buffer.alloc(2000001);let used=0;
    while(used<bytes.length){const {bytesRead}=await file.read(bytes,used,bytes.length-used,null);if(!bytesRead)break;used+=bytesRead;}
    if(used>2000000) throw Error('EXPORT_SIZE_LIMIT');return bytes.subarray(0,used);
  } finally {await file.close();}
}
export async function* exportSource(inputPath) {
  const path=resolve(inputPath);const stat=await lstat(path);
  if(stat.isSymbolicLink()) throw Error('SYMLINK_NOT_ALLOWED');
  let paths;
  if(stat.isDirectory()) {
    const entries=await readdir(path,{withFileTypes:true});
    if(entries.length>1000) throw Error('DIRECTORY_ENTRY_LIMIT');
    paths=entries.sort((a,b)=>a.name.localeCompare(b.name)).map(e=>join(path,e.name));
  } else paths=[path];
  for(const file of paths) {
    const sourceName=basename(file);
    try {
      const extension=extname(file).toLowerCase();
      if(!['.xml','.zip'].includes(extension)) {yield {sourceName,error:'UNSUPPORTED_EXPORT_FILE'};continue;}
      const bytes=await readLimited(file);
      if(extension==='.xml') {yield {sourceName,bytes};continue;}
      const entries=await xmlEngine({mode:'unpack-export',base64:bytes.toString('base64')});
      if(!entries.length) yield {sourceName,error:'EMPTY_ZIP'};
      for(const e of entries) yield {sourceName:sourceName+'!'+e.name,...(e.error?{error:e.error}:{bytes:Buffer.from(e.base64,'base64')})};
    } catch {yield {sourceName,error:'EXPORT_READ_OR_ARCHIVE_FAILED'};}
  }
}
