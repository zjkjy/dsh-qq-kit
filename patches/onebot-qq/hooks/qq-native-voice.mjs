import fs from 'node:fs';
const settingsPath=new URL('../speech/qq-native.json',import.meta.url);
export function nativeVoiceSettings(){
 const s=JSON.parse(fs.readFileSync(settingsPath,'utf8'));
 if(s.engine!=='qq-native'||s.fallbackToWhisper!==false)throw new Error('Expected qq-native engine with explicit no-Whisper fallback');
 return {...s,maxAttempts:Math.max(1,Math.min(10,Number(s.maxAttempts)||1)),retryDelayMs:Math.max(0,Math.min(3000,Number(s.retryDelayMs)||0))};
}
export async function fetchNativeVoice(call,messageId,settings=nativeVoiceSettings(),sleep=ms=>new Promise(r=>setTimeout(r,ms))){
 if(messageId===undefined||messageId===null||String(messageId)==='')throw new Error('Voice message id missing');
 let lastError;
 for(let attempt=0;attempt<settings.maxAttempts;attempt++){
  try{
   const result=await call('fetch_ptt_text',{message_id:messageId});
   const text=typeof result?.text==='string'?result.text.trim():'';
   if(!text)throw new Error('QQ native voice text not ready');
   return {text,attempts:attempt+1};
  }catch(e){
   lastError=e;
   if(/timed out|not connected|消息不存在|不包含语音|unknown action|unsupported action/i.test(String(e?.message??e)))break;
   if(attempt+1<settings.maxAttempts)await sleep(settings.retryDelayMs);
  }
 }
 throw lastError??new Error('QQ native voice transcription failed');
}
export async function prepareNativeVoice(inbound,ctx){
 const voices=inbound.media.filter(ref=>ref.kind==='voice');
 if(!voices.length||!ctx.transcriber.enabled)return {text:inbound.text,media:inbound.media};
 const settings=nativeVoiceSettings();
 if(!settings.enabled)return {text:inbound.text,media:inbound.media};
 let speech;
 try{
  const result=await fetchNativeVoice((action,params)=>ctx.call(action,params),inbound.messageId,settings);
  speech=result.text;
  ctx.log('debug','QQ native voice resolved before dispatch; attempts='+result.attempts);
 }catch(error){
  ctx.log('warn','QQ native voice recognition failed: '+String(error?.message??error));
  speech='[这条语音暂时没能识别清楚]';
 }
 // The final user_message wrapper still escapes sender content. Do not add a
 // transcription label: speech has the same conversational meaning as typed text.
 let text=inbound.text;
 for(const ref of voices)text=text.replace('[语音]',()=>speech);
 if(text===inbound.text&&!text.includes(speech))text=[text,speech].filter(Boolean).join('\n');
 return {text,media:inbound.media.filter(ref=>ref.kind!=='voice')};
}
