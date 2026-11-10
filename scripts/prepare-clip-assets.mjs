import fs from'node:fs';import path from'node:path';import crypto from'node:crypto';
const project=path.resolve(import.meta.dirname,'..'),manifest=JSON.parse(fs.readFileSync(new URL('./clip-assets-manifest.json',import.meta.url)));
if(!/^D:/i.test(project))throw Error('CLIP resources must be stored on D drive.');
const args=Object.fromEntries(process.argv.slice(2).map(a=>{const i=a.indexOf('=');return[a.slice(0,i),a.slice(i+1)]}));
const input=args['--from'],notices=args['--notices'];if(!input||!notices)throw Error('Usage: node scripts/prepare-clip-assets.mjs --from=D:/approved-fixed-model-directory --notices=D:/approved-licenses-directory');
const hash=b=>crypto.createHash('sha256').update(b).digest('hex');
const dest=project+'/public/medclip-clip/',model=dest+manifest.model.id+'/'+manifest.model.revision+'/';
const copies=[];
for(const f of manifest.files){const b=fs.readFileSync(path.join(input,f.file));if(hash(b)!==f.sha256)throw Error('Source hash mismatch: '+f.file);copies.push({b,to:model+f.file,sha256:f.sha256});}
const pkg=JSON.parse(fs.readFileSync(project+'/node_modules/@huggingface/transformers/package.json'));if(pkg.version!=='3.8.1')throw Error('Unverified Transformers.js version');
for(const f of manifest.runtime){const b=fs.readFileSync(project+'/node_modules/@huggingface/transformers/dist/'+f.file);if(hash(b)!==f.sha256)throw Error('Runtime hash mismatch '+f.file);copies.push({b,to:dest+'runtime/'+f.file,sha256:f.sha256});}
for(const f of manifest.notices){const b=fs.readFileSync(path.join(notices,f.file));if(hash(b)!==f.sha256)throw Error('License hash mismatch '+f.file);copies.push({b,to:dest+'licenses/'+f.file,sha256:f.sha256});}
// Validate the complete pack before any mutation. Never overwrite different assets.
for(const c of copies)if(fs.existsSync(c.to)&&hash(fs.readFileSync(c.to))!==c.sha256)throw Error('Destination conflict '+c.to);
for(const c of copies){fs.mkdirSync(path.dirname(c.to),{recursive:true});if(!fs.existsSync(c.to))fs.writeFileSync(c.to,c.b,{flag:'wx'});}
console.log(JSON.stringify({destination:dest,files:copies.length,model:manifest.model,verified:true},null,2));