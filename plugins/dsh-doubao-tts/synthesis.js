import fs from 'node:fs/promises';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
export const SETTINGS='D:/DSH-Data/speech/doubao/settings.json';
export const OUTPUT_DIR='D:/DSH-Data/qq/media';
const ENDPOINT_TTS='https://openspeech.bytedance.com/api/v3/tts/unidirectional';
const ENDPOINT_AUDIO='https://openspeech.bytedance.com/api/v3/tts/create';
const SEED_AUDIO_MODELS=new Set(['seed-audio-1.0']);
const MP3_RATES=new Set([8000,16000,24000,32000,44100,48000]);
export function isSeedAudio(c){return SEED_AUDIO_MODELS.has(String(c.model??'').trim())||c.api==='seed-audio';}
export function validateConfig(c){
 if(!['app-token','api-key'].includes(c.authMode))throw Error('豆包语音 authMode 须为 app-token 或 api-key');
 if(!c.apiKey&&(!c.appId||!c.accessToken))throw Error('请在本地 settings.json 填写 appId 和 accessToken（新版控制台可只填 apiKey）');
 if(c.format!=='mp3')throw Error('当前配置仅支持 MP3');
 if(isSeedAudio(c)){
  if(!c.apiKey&&(!c.appId||!c.accessToken))throw Error('Seed-Audio 1.0 需要鉴权：填 apiKey（新版控制台）或 appId+accessToken（旧版控制台），二选一');
  if(!MP3_RATES.has(Number(c.sampleRate)||24000))throw Error('MP3 采样率须为 8000/16000/24000/32000/44100/48000');
  return;
 }
 if(!c.resourceId||!c.speaker)throw Error('请填写已开通的 resourceId 与对应音色 speaker');
 if(c.sampleRate!==24000)throw Error('当前配置仅支持 MP3、24000 Hz');
}
export function parseEvents(data){
 const audio=[];let completed=false;
 for(const line of data.split(/\r?\n/)){
  if(!line.trim())continue;
  let item;try{item=JSON.parse(line)}catch{throw Error('豆包语音响应格式错误');}
  if(item.code===20000000){completed=true;continue;}
  if(item.code!==0&&item.code!==3000)throw Error('豆包语音请求失败，服务错误码 '+String(item.code??'unknown'));
  if(item.data){if(typeof item.data!=='string'||!/^[A-Za-z0-9+/]+={0,2}$/.test(item.data))throw Error('豆包音频数据格式错误');audio.push(Buffer.from(item.data,'base64'));}
 }
 if(!completed||!audio.length)throw Error('豆包语音返回不完整或没有音频');
 const result=Buffer.concat(audio);if(result.length>15*1024*1024)throw Error('语音文件超过QQ发送上限');return result;
}
async function applyGain(audio, gainDb, ffmpegPath, loudnessTarget){
 const db=Number(gainDb);
 const target=Number(loudnessTarget);
 const useNorm=Number.isFinite(target)&&target<0;
 if(!useNorm&&(!Number.isFinite(db)||db===0))return audio;
 if(!useNorm&&Math.abs(db)>24)throw Error('gainDb 需在 -24 到 24 之间');
 if(useNorm&&(target<-24||target>-5))throw Error('loudnessTarget 需在 -24 到 -5 LUFS 之间');
 const {execFile}=await import('node:child_process');
 const {promisify}=await import('node:util');
 const os=await import('node:os');
 const run=promisify(execFile);
 const tmpIn=path.join(os.tmpdir(),'dsh-tts-in-'+randomUUID()+'.mp3');
 const tmpOut=path.join(os.tmpdir(),'dsh-tts-out-'+randomUUID()+'.mp3');
 await fs.writeFile(tmpIn,audio);
 try{
  let filter;
  if(useNorm){
   const eg=await run(ffmpegPath||'ffmpeg',['-hide_banner','-nostats','-i',tmpIn,'-af','ebur128=peak=true','-f','null','-'],{windowsHide:true,timeout:30000}).catch(e=>({stderr:String((e&&e.stderr)||'')}));
   const txt=String(eg.stderr||'');
   const mm=[...txt.matchAll(/I:\s+(-?\d+\.\d) LUFS/g)].pop();
   if(!mm)throw Error('loudness analyse failed');
   const cur=Number(mm[1]);
   const delta=Math.max(0,Math.min(30,target-cur));
   filter='volume='+delta.toFixed(1)+'dB,alimiter=limit=0.80:attack=4:release=60';
  }else{
   filter='volume='+db+'dB,alimiter=limit=0.95:attack=5:release=50';
  }
  await run(ffmpegPath||'ffmpeg',['-hide_banner','-loglevel','error','-y','-i',tmpIn,'-af',filter,'-codec:a','libmp3lame','-b:a','96k',tmpOut],{windowsHide:true,timeout:30000});
  return await fs.readFile(tmpOut);
 }finally{
  await fs.rm(tmpIn,{force:true}).catch(()=>{});
  await fs.rm(tmpOut,{force:true}).catch(()=>{});
 }
}
async function writeAudio(audio,outputDir){
 if(!audio.length)throw Error('豆包返回的音频为空');
 if(audio.length>15*1024*1024)throw Error('语音文件超过QQ发送上限');
 await fs.mkdir(outputDir,{recursive:true});
 const output=path.join(outputDir,'doubao-tts-'+randomUUID()+'.mp3');
 await fs.writeFile(output,audio,{flag:'wx'});
 return output;
}
export async function synthesize(text,{fetchImpl=fetch,settingsFile=SETTINGS,outputDir=OUTPUT_DIR}={}){
 const c=JSON.parse(await fs.readFile(settingsFile,'utf8'));validateConfig(c);
 if(typeof text!=='string'||!text.trim())throw Error('合成文字不能为空');
 const seed=isSeedAudio(c);
 const cap=seed?3000:1000;
 const max=Math.min(cap,Math.max(1,Number(c.maxCharacters)||cap));
 if(Array.from(text).length>max)throw Error('文字超过本地设置的长度上限 '+max);
 const timeout=Math.max(1000,Math.min(120000,Number(c.timeoutMs)||60000));
 const headers={'Content-Type':'application/json'};
 if(seed){if(c.apiKey)headers['X-Api-Key']=c.apiKey;else{headers['X-Api-App-Id']=c.appId;headers['X-Api-Access-Key']=c.accessToken;}}
 else{headers['X-Api-Request-Id']=randomUUID();if(c.apiKey)headers['X-Api-Key']=c.apiKey;else{headers['X-Api-App-Id']=c.appId;headers['X-Api-Access-Key']=c.accessToken;}}
 if(seed){
  const params={model:String(c.model||'seed-audio-1.0').trim(),text_prompt:text,audio_config:{format:'mp3',sample_rate:Number(c.sampleRate)||24000}};
  const spk=String(c.speaker??'').trim();
   if(!spk)throw Error('seed-audio 需要在 settings.json 填 speaker（音色 id），留空会由服务端随机挑声线');
   params.references=[{speaker:spk}];
  if(c.speechRate!==undefined)params.audio_config.speech_rate=Number(c.speechRate)||0;
  const post=(h)=>fetchImpl(ENDPOINT_AUDIO,{method:'POST',headers:{...headers,...h},body:JSON.stringify(params),signal:AbortSignal.timeout(timeout)});
  let response=await post({});
  if(seed&&c.apiKey&&response.status===401&&c.appId&&c.accessToken){
   await response.text().catch(()=> '');
   const retry={'Content-Type':'application/json','X-Api-App-Id':c.appId,'X-Api-Access-Key':c.accessToken};
   response=await fetchImpl(ENDPOINT_AUDIO,{method:'POST',headers:retry,body:JSON.stringify(params),signal:AbortSignal.timeout(timeout)});
  }
  if(!response.ok){const txt=await response.text().catch(()=> '');throw Error('音频生成请求失败，HTTP '+response.status+(response.status===401?'：鉴权被拒（apiKey 与 appId/accessToken 都试过了，核对控制台凭据）':'')+' '+txt.slice(0,200));}
  const body=await response.text();if(body.length>24*1024*1024)throw Error('豆包响应超过大小上限');
  let payload;try{payload=JSON.parse(body)}catch{throw Error('豆包音频生成响应格式错误');}
  if(payload.code!==undefined&&payload.code!==0&&payload.code!==20000000)throw Error('音频生成失败，服务错误码 '+String(payload.code)+' '+(payload.message??''));
  if(typeof payload.audio!=='string'||!/^[A-Za-z0-9+/]+={0,2}$/.test(payload.audio))throw Error('音频生成返回不含音频数据');
  return writeAudio(await applyGain(Buffer.from(payload.audio,'base64'),c.gainDb,c.ffmpegPath,c.loudnessTarget),outputDir);
 }
 headers['X-Api-Resource-Id']=c.resourceId;
 const params={text,speaker:c.speaker,audio_params:{format:'mp3',sample_rate:24000}};if(c.model)params.model=c.model;
 const response=await fetchImpl(ENDPOINT_TTS,{method:'POST',headers,body:JSON.stringify({user:{uid:'dsh-qq'},req_params:params}),signal:AbortSignal.timeout(timeout)});
 if(!response.ok)throw Error('豆包语音请求失败，HTTP '+response.status+'；请核对凭据与资源权限');
 const body=await response.text();if(body.length>24*1024*1024)throw Error('豆包响应超过大小上限');
 return writeAudio(await applyGain(parseEvents(body),c.gainDb,c.ffmpegPath,c.loudnessTarget),outputDir);
}


