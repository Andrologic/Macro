import { expect, test } from 'bun:test';
import { observeConversationMessage } from './conversationReadObservation';

test('virtual overscan, background documents and selection do not acknowledge an unseen response',()=>{
  const original = globalThis.IntersectionObserver;
  const originalFocus = document.hasFocus;
  const originalVisibility = Object.getOwnPropertyDescriptor(document,'visibilityState');
  let callback: IntersectionObserverCallback | undefined; let focused = false;let shown = true;let calls = 0;let disconnected=false;
  globalThis.IntersectionObserver = class { constructor(cb:IntersectionObserverCallback){callback=cb;}observe(){}disconnect(){disconnected=true;} } as unknown as typeof IntersectionObserver;
  document.hasFocus=()=>focused;Object.defineProperty(document,'visibilityState',{configurable:true,get:()=>shown?'visible':'hidden'});
  const element=document.createElement('div');document.body.append(element);
  try {
    const stop=observeConversationMessage(element,()=>{calls++;});
    const intersect=(visible:boolean)=>callback!([{target:element,isIntersecting:visible} as unknown as IntersectionObserverEntry],{} as IntersectionObserver);
    intersect(false);focused=true;window.dispatchEvent(new Event('focus'));expect(calls).toBe(0);
    shown=false;intersect(true);expect(calls).toBe(0);shown=true;focused=false;document.dispatchEvent(new Event('visibilitychange'));expect(calls).toBe(0);
    focused=true;window.dispatchEvent(new Event('focus'));expect(calls).toBe(1);intersect(true);expect(calls).toBe(1);stop();expect(disconnected).toBe(true);
  }finally{element.remove();globalThis.IntersectionObserver=original;document.hasFocus=originalFocus;if(originalVisibility)Object.defineProperty(document,'visibilityState',originalVisibility);else Reflect.deleteProperty(document,'visibilityState');}
});
