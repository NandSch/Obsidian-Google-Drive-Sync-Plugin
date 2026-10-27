import { build } from 'esbuild';
import { readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
const {version}=JSON.parse(readFileSync('manifest.json','utf8'));
await build({entryPoints:['src/main.ts'],bundle:true,platform:'node',target:'es2022',format:'cjs',external:['obsidian','electron'],outfile:'main.js',sourcemap:false,banner:{js:`/* Drive Vault Sync ${version} | MIT | Source supplied alongside this build. */`}});
const hashes=Object.fromEntries(['main.js','manifest.json','styles.css'].map(file=>[file,createHash('sha256').update(readFileSync(file)).digest('hex')]));
writeFileSync('checksums.json',JSON.stringify(hashes,null,2)+'\n');
