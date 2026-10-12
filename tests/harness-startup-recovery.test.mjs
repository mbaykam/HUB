import assert from 'node:assert/strict';
import {mkdtemp, mkdir, readFile, writeFile, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import test from 'node:test';
import {HarnessRuntime} from '../desktop/main/harness-runtime.ts';

const token = 'r'.repeat(43);
const url = 'http://127.0.0.1:43217/?token=' + token;
async function fixture(mode, run) {
  const root = await mkdtemp(join(tmpdir(), 'hub-startup-recovery-'));
  const runtimeRoot = join(root, 'runtime'), data = join(root, 'data');
  const patch = join(runtimeRoot, 'node_modules/@lencx/minke-harness-overlay');
  const pnpm = join(runtimeRoot, 'node_modules/pnpm/bin');
  let runtime;
  const unexpected = [];
  try {
    await Promise.all([mkdir(patch,{recursive:true}),mkdir(pnpm,{recursive:true}),mkdir(join(runtimeRoot,'bin'),{recursive:true}),mkdir(data,{recursive:true})]);
    await Promise.all([
      writeFile(join(runtimeRoot,'dsh-runtime.json'),JSON.stringify({schemaVersion:3,productBundle:{packageName:'@lencx/minke-harness-overlay',patch:'cordis.patch.yml'}})),
      writeFile(join(patch,'cordis.patch.yml'),''),writeFile(join(pnpm,'pnpm.cjs'),''),
      writeFile(join(runtimeRoot,'index.mjs'),[
        "import {appendFileSync,existsSync,writeFileSync} from 'node:fs';",
        "import {join} from 'node:path';",
        "const home=process.env.DSH_HOME, warm=join(home,'warm');",
        "const first=!existsSync(warm); writeFileSync(warm,'ready');",
        "appendFileSync(join(home,'pids'),process.pid+'\\n');",
        "process.stdout.write('initializing ?token=" + token + "\\n');",
        mode==='exit'?"process.exit(19);":mode==='warm'?"if(!first) process.stdout.write("+JSON.stringify('dsh web: '+url+'\n')+");":"",
        "setInterval(()=>{},1000);",
      ].join('\n')),
    ]);
    runtime = new HarnessRuntime({runtimeRoot,dshHome:data,electronExecutable:process.execPath,
      modelRuntimes:{lmStudio:{enabled:false},ollama:{enabled:false}},
      pluginManagement:{safeMode:false,disabledPlugins:[]},webSearch:{fallbackEnabled:false},
      startupTimeoutMs:2000,shutdownTimeoutMs:1000,onUnexpectedExit:exit=>unexpected.push(exit)});
    const pids = async()=>{try{return (await readFile(join(data,'pids'),'utf8')).trim().split('\n').filter(Boolean).map(Number);}catch(e){if(e.code==='ENOENT')return[];throw e;}};
    await run(runtime,pids);
    assert.deepEqual(unexpected,[], 'Startup cleanup must not masquerade as a running session crash');
  } finally {await runtime?.stop();await rm(root,{recursive:true,force:true});}
}
function assertExited(pid) {
  assert.throws(()=>process.kill(pid,0),error=>error.code==='ESRCH','Failed startup process is still alive');
}

test('a cold readiness timeout closes the old child and retries once with the warm runtime',async()=>{
  await fixture('warm',async(runtime,pids)=>{
    const endpoint=await runtime.start();
    assert.equal(endpoint.origin,'http://127.0.0.1:43217');
    assert.equal(endpoint.launchToken,token);
    const launched=await pids();
    assert.equal(launched.length,2);
    assertExited(launched[0]);
    assert.doesNotThrow(()=>process.kill(launched[1],0));
    await runtime.stop();assertExited(launched[1]);
  });
});

test('repeated readiness failure is bounded to two starts and leaves no child or unredacted token',async()=>{
  await fixture('never',async(runtime,pids)=>{
    await assert.rejects(runtime.start(),error=>error.name==='HarnessStartupTimeoutError'&&error.message.includes('token=<redacted>')&&!error.message.includes(token));
    const launched=await pids();assert.equal(launched.length,2);
    for(const pid of launched)assertExited(pid);
  });
});

test('an exited startup process is not retried as a cold timeout',async()=>{
  await fixture('exit',async(runtime,pids)=>{
    await assert.rejects(runtime.start(),/Harness exited before readiness \(code 19/);
    const launched=await pids();assert.equal(launched.length,1);assertExited(launched[0]);
  });
});

test('stopping during startup cancels the launch without starting a replacement',async()=>{
  await fixture('never',async(runtime,pids)=>{
    const start=runtime.start();void start.catch(()=>{});
    const deadline=Date.now()+5000;
    while(!(await pids()).length&&Date.now()<deadline)await new Promise(resolve=>setTimeout(resolve,10));
    await runtime.stop();
    await assert.rejects(start,/Harness exited before readiness/);
    const launched=await pids();assert.equal(launched.length,1);assertExited(launched[0]);
  });
});

test('stopping before the asynchronous launch setup completes prevents any child spawn',async()=>{
  await fixture('warm',async(runtime,pids)=>{
    const start=runtime.start();void start.catch(()=>{});
    await runtime.stop();
    await assert.rejects(start,/Harness startup cancelled/);
    assert.deepEqual(await pids(),[]);
  });
});
