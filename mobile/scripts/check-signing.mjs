import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
const result=spawnSync(process.platform==='win32'?'python':'python3',['-m','unittest','discover','-s','test','-p','test_signing_policy.py'],{cwd:fileURLToPath(new URL('../',import.meta.url)),stdio:'inherit',shell:false});
if(result.error)throw result.error;
if(result.status!==0)process.exit(result.status??1);
