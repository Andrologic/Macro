import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
const directory=new URL('../v2/',import.meta.url);
const schemas=['transfer-decision.schema.json','transfer-transit/schema.json'].map(p=>JSON.parse(readFileSync(new URL(p,directory),'utf8')));
const byId=new Map(schemas.map(s=>[s.$id,s]));
const wire=x=>Buffer.byteLength(JSON.stringify(x));
function maximum(s,root,options={}) {
 if(s.$ref){const [base,key]=s.$ref.split('#/$defs/');return maximum((base?byId.get(base):root).$defs[key],base?byId.get(base):root,options);}
 if('const'in s)return wire(s.const);
 if(s.enum)return Math.max(...s.enum.map(wire));
 if(s.oneOf)return Math.max(...s.oneOf.map(x=>maximum(x,root,options)));
 if(s.type==='null')return 4;
 if(s.type==='boolean')return 5;
 if(s.type==='string') {
  if(!Number.isSafeInteger(s.maxLength))throw Error('Unbounded string');
  // Existing F ID/decimal/hash alphabets require no JSON escaping. Origin
  // strings are conservatively budgeted at6 bytes per code unit here.
  const ascii=s.pattern&&s.pattern.includes('[0-9')||s.not?.pattern&&/\[\^.*A-Za-z|\[\^0-9a-f|\[\^0-9\]/.test(s.not.pattern);
  return 2+s.maxLength*(ascii?1:6);
 }
 if(s.type==='array'){assert.ok(Number.isSafeInteger(s.maxItems));return 2+Math.max(0,s.maxItems-1)+s.maxItems*maximum(s.items,root,options);}
 if(s.type==='object') {
  const properties=Object.entries(s.properties);return 2+Math.max(0,properties.length-1)+properties.reduce((n,[k,v])=>n+wire(k)+1+(k==='data_utf8'&&options.emptyData?2:maximum(v,root,options)),0);
 }
 throw Error('Review schema bound');
}
export function verifyBounds() {
 const root=schemas[1],chunk=root.$defs.chunk,delivery=structuredClone(root.$defs.delivery);
 delivery.properties.body=root.$defs.deliveryBody.oneOf[2];
 const controls={chunk:maximum(chunk,root,{emptyData:true})-2,delivery:maximum(delivery,root,{emptyData:true})-2};
 assert.ok(Math.max(...Object.values(controls))<=4096);
 const ordinary={};for(const [name,s]of Object.entries(root.$defs)){if(['chunk','deliveryBody','message','delivery'].includes(name))continue;ordinary[name]=maximum(s,root);assert.ok(ordinary[name]<=98304,name);}
 assert.ok(94208+Math.max(...Object.values(controls))<=98304);
 assert.equal(98304*256+1048576+2097152,28311552);
 const reservation=98304*256+1048576+2097152;assert.ok(reservation<33554432&&reservation<67108864);
 return {controls,ordinary,wireMax:98304,graph:25165824,working:1048576,copies:2097152,logicalReservation:28311552,remainingPerInstance:5242880};
}
if(import.meta.url===new URL(process.argv[1],'file:').href)console.log(JSON.stringify(verifyBounds()));
