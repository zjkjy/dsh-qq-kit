import {defineTool} from '@deepseek-ai/dsh-tools';
import {synthesize} from './synthesis.js';
export const name='doubao-tts';
export const inject=['tools'];
export function apply(ctx){
 const dispose=ctx.tools.register(defineTool({
  name:'doubao_tts_synthesize',
  description:'将拟回复的文字用火山引擎豆包语音合成，返回本地音频路径。仅在用户明确要求语音回复时使用；QQ会话中成功后把返回路径交给 qq_send_voice 发送。失败时如实说明，不得声称已发送。不要读取或输出配置文件中的凭据。',
  parameters:{text:{type:'string',required:true,description:'需要用语音说出的最终回答，简洁自然；不要包含凭据或用户未要求外传的内容。'}},
  output:{schema:{type:'json'},render:(_args,value)=>[{type:'text',text:'语音已合成，文件路径：'+value.path+'；QQ 会话请调用 qq_send_voice 发送。'}]},
  isConcurrencySafe:()=>true,
  execute:async(args)=>({path:await synthesize(args.text)})
 }));
 ctx.effect(()=>()=>dispose());
 console.info('[doubao-tts] synthesis tool registered');
}
