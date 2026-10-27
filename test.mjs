import { build } from 'esbuild';
import { spawnSync } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import path from 'node:path';
mkdirSync('.test-build', { recursive: true });
const names=['sync','drive','storage','auth','local','close','lifecycle','progress'];
await build({entryPoints:names.map(n=>`tests/${n}.test.ts`),bundle:true,platform:'node',target:'node22',format:'cjs',external:['electron'],outdir:'.test-build',outExtension:{'.js':'.cjs'},plugins:[{name:'mock-obsidian',setup(build){build.onResolve({filter:/^obsidian$/},()=>({path:path.resolve('tests/obsidian-mock.ts')}));}}]});
const r=spawnSync(process.execPath,['--test',...names.map(n=>`.test-build/${n}.test.cjs`)],{stdio:'inherit'});
process.exitCode=r.status??1;
